import CoreVideo
import Metal
import QuartzCore

/**
 * Draws one alpha-packed BGRA video frame into a CAMetalLayer, recombining
 * color (top half) with the grayscale alpha matte (bottom half).
 *
 * Invariants shared with the Android GLSL renderer — do not regress:
 * - The packed video's color is PREMULTIPLIED by the packer; the fragment
 *   shader passes rgb through untouched, and pipeline blending is DISABLED.
 *   Multiplying rgb by alpha again (or blending with GL_SRC_ALPHA-style
 *   factors) darkens edges: the quad covers the whole cleared (0,0,0,0)
 *   drawable and Core Animation already composites CALayer contents as
 *   premultiplied.
 * - The halves split happens in normalized content space. Unlike Android
 *   (SurfaceTexture exposes the decoder's row-padded buffer, crop carried in
 *   uSTMatrix), iOS vends CVPixelBuffers cropped to display size — decoder
 *   padding only widens bytesPerRow, which CVMetalTextureCache absorbs as row
 *   pitch — so cropRect stays (0,0,1,1). It exists as the contingency knob:
 *   if a device ever vends clean-aperture padding, populate it from
 *   kCVImageBufferCleanApertureKey and keep the split BEFORE the crop.
 *
 * The Metal device/queue/pipeline are process-wide statics (immutable,
 * expensive); the texture cache and held frames are per view. The shader is
 * compiled from source at runtime on purpose: a .metal file in a static
 * CocoaPods framework lands in the app's default metallib (or nowhere), while
 * makeLibrary(source:) is self-contained and fails loudly.
 */
final class TransparentVideoRenderer {
  static let device: MTLDevice? = MTLCreateSystemDefaultDevice()
  private static let commandQueue: MTLCommandQueue? = device?.makeCommandQueue()
  private static let pipelineState: MTLRenderPipelineState? = makePipelineState()

  private struct Frame {
    let texture: MTLTexture
    // CVMetalTexture + CVPixelBuffer must outlive every GPU read of
    // `texture` (texture-cache contract) — releasing them early hands the
    // IOSurface back to the decoder pool mid-render.
    let cvTexture: CVMetalTexture
    let pixelBuffer: CVPixelBuffer
  }

  private var textureCache: CVMetalTextureCache?
  // Most recently encoded frame. Kept alive so it can be re-presented after
  // backgrounding/reattach purges the layer's drawables, and because the GPU
  // may still be reading it. Exactly one frame (plus one briefly in flight)
  // is retained, keeping the decoder's buffer pool at its minimum.
  private var lastFrame: Frame?

  private static let shaderSource = """
  #include <metal_stdlib>
  using namespace metal;

  struct VOut {
    float4 pos [[position]];
    float2 uv;
  };

  // Fullscreen triangle from vertex_id — no vertex buffers. uv.y == 0 at the
  // layer top, matching CVPixelBuffer row 0 (= packed color half).
  vertex VOut tv_vertex(uint vid [[vertex_id]]) {
    float2 p = float2((vid << 1) & 2, vid & 2);
    VOut out;
    out.pos = float4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
    out.uv = p;
    return out;
  }

  fragment float4 tv_fragment(VOut in [[stage_in]],
                              texture2d<float> video [[texture(0)]],
                              constant float4 &cropRect [[buffer(0)]]) {
    constexpr sampler s(address::clamp_to_edge, filter::linear);
    // Halves split in content space, BEFORE the crop (Android invariant).
    float2 colorUV = float2(in.uv.x, in.uv.y * 0.5);
    float2 alphaUV = float2(in.uv.x, 0.5 + in.uv.y * 0.5);
    colorUV = cropRect.xy + colorUV * cropRect.zw;
    alphaUV = cropRect.xy + alphaUV * cropRect.zw;
    float3 rgb = video.sample(s, colorUV).rgb;
    float  a   = video.sample(s, alphaUV).r;
    // PREMULTIPLIED passthrough — never multiply rgb by a here.
    return float4(rgb, a);
  }
  """

  private static func makePipelineState() -> MTLRenderPipelineState? {
    guard let device else { return nil }
    do {
      let library = try device.makeLibrary(source: shaderSource, options: nil)
      guard let vertexFn = library.makeFunction(name: "tv_vertex"),
            let fragmentFn = library.makeFunction(name: "tv_fragment") else {
        return nil
      }
      let descriptor = MTLRenderPipelineDescriptor()
      descriptor.vertexFunction = vertexFn
      descriptor.fragmentFunction = fragmentFn
      descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
      descriptor.colorAttachments[0].isBlendingEnabled = false
      return try device.makeRenderPipelineState(descriptor: descriptor)
    } catch {
      // A compile failure here means the shader source itself is broken —
      // surface it during development instead of silently rendering nothing.
      assertionFailure("TransparentVideo: Metal pipeline setup failed: \(error)")
      return nil
    }
  }

  var hasFrame: Bool { lastFrame != nil }

  /// Wraps the pixel buffer as a Metal texture and draws it into the layer.
  func render(pixelBuffer: CVPixelBuffer, into layer: CAMetalLayer) {
    guard let device = Self.device else { return }
    if textureCache == nil {
      CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, device, nil, &textureCache)
    }
    guard let cache = textureCache else { return }

    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)
    var cvTextureOut: CVMetalTexture?
    let status = CVMetalTextureCacheCreateTextureFromImage(
      kCFAllocatorDefault, cache, pixelBuffer, nil, .bgra8Unorm, width, height, 0, &cvTextureOut)
    guard status == kCVReturnSuccess,
          let cvTexture = cvTextureOut,
          let texture = CVMetalTextureGetTexture(cvTexture) else {
      return
    }

    let frame = Frame(texture: texture, cvTexture: cvTexture, pixelBuffer: pixelBuffer)
    let previous = lastFrame
    lastFrame = frame
    encode(frame: frame, into: layer, retiring: previous)
  }

  /// Re-presents the held frame into a fresh drawable — needed after
  /// backgrounding or a drawable resize discards the layer's contents.
  func redrawLastFrame(into layer: CAMetalLayer) {
    guard let frame = lastFrame else { return }
    encode(frame: frame, into: layer, retiring: nil)
  }

  private func encode(frame: Frame, into layer: CAMetalLayer, retiring previous: Frame?) {
    guard let queue = Self.commandQueue,
          let pipeline = Self.pipelineState,
          layer.drawableSize.width > 0, layer.drawableSize.height > 0,
          let drawable = layer.nextDrawable() else {
      return
    }

    let passDescriptor = MTLRenderPassDescriptor()
    passDescriptor.colorAttachments[0].texture = drawable.texture
    passDescriptor.colorAttachments[0].loadAction = .clear
    passDescriptor.colorAttachments[0].storeAction = .store
    passDescriptor.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)

    guard let commandBuffer = queue.makeCommandBuffer(),
          let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: passDescriptor) else {
      return
    }
    encoder.setRenderPipelineState(pipeline)
    encoder.setFragmentTexture(frame.texture, index: 0)
    var cropRect = SIMD4<Float>(0, 0, 1, 1)
    encoder.setFragmentBytes(&cropRect, length: MemoryLayout<SIMD4<Float>>.size, index: 0)
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    encoder.endEncoding()
    commandBuffer.present(drawable)
    if let previous {
      // Release the replaced frame only once the GPU is done with this pass
      // (the queue is serial, so any read of `previous` finished earlier).
      commandBuffer.addCompletedHandler { _ in _ = previous }
    }
    commandBuffer.commit()
  }

  func release() {
    lastFrame = nil
    if let cache = textureCache {
      CVMetalTextureCacheFlush(cache, 0)
    }
    textureCache = nil
  }
}
