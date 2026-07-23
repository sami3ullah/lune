/**
 * The pinned Provisioning manifest (ADR-0009): exactly which artifacts each local
 * Runtime needs, pinned to a specific version with an expected size and checksum.
 *
 * Pinning is deliberate - a working setup stays working, and an update is explicit,
 * never a silent background download. The checksum is what lets a corrupted
 * download be detected and re-fetched, and the size feeds the disk preflight and
 * the progress bar before a byte is fetched.
 *
 * All artifacts are downloaded into one Lune-managed models directory so reclaiming
 * disk or uninstalling is a single obvious action (ADR-0009).
 *
 * Lune has only file artifacts: whisper's weights and the Kokoro ONNX model + its
 * 54 per-voice files are single pinned files fetched by the resumable, checksum-
 * verified download path into the managed directory. (v1 also provisioned an
 * LM Studio-managed MLX model for local Reasoning; Lune drops all local Reasoning,
 * so there is no LM Studio path here - Reasoning is cloud-only.)
 */

/** The local Runtimes Provisioning can set up (matches the routing config). */
export type ProvisionableRuntimeId = "whisper" | "kokoro";

/** One pinned, downloadable file (model weights, voice pack, etc.). */
export interface PinnedArtifact {
  /** Stable id, unique within the manifest (e.g. "whisper-large-v3-turbo"). */
  id: string;
  /** Human-readable name for progress UI. */
  displayName: string;
  /** Path, relative to the managed models directory, where the finished file lives. */
  relativePath: string;
  /** Pinned download URL for this exact version. */
  url: string;
  /** Expected lowercase-hex SHA-256 of the finished file; the verification anchor. */
  sha256: string;
  /** Expected size in bytes - drives the disk preflight and progress totals. */
  sizeBytes: number;
  /**
   * Pinned version string (ADR-0009: versions are pinned). Carried for display and
   * to make an explicit version bump legible in the manifest; the actual pin is
   * enforced by the `url` + `sha256`.
   */
  version: string;
}

/** A local Runtime plus the pinned artifacts it needs to be usable. */
export interface ProvisionableRuntime {
  id: ProvisionableRuntimeId;
  displayName: string;
  /** Pinned files fetched by the checksum-verified download path. */
  artifacts: PinnedArtifact[];
}

/**
 * The public HuggingFace host serving the pinned open-weights artifacts. Kept in
 * one constant so a future move to a Lune-hosted mirror is a one-line change.
 */
const HUGGINGFACE_HOST = "https://huggingface.co";

/**
 * Kokoro-82M's 54 built-in voices, each a tiny (~510 KB) style-embedding file in
 * the `onnx-community/Kokoro-82M-v1.0-ONNX` repo (there is no combined voice pack).
 * Pinned as `[voice, sha256]` pairs - every voice file is exactly 522,240 bytes.
 * Kept in lockstep with the Kokoro Speech engine's voice list when that Capability
 * is ported.
 */
const KOKORO_VOICE_CHECKSUMS: ReadonlyArray<readonly [voice: string, sha256: string]> = [
  ["af_heart", "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b"],
  ["af_alloy", "c4a6b876047fd7fb472edf4ebd63cfac7c3b958a7cae7c106e8f038ca6308c45"],
  ["af_aoede", "4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361"],
  ["af_bella", "f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b"],
  ["af_jessica", "a240a5e3c15b43563d6e923bdca8ef5613a23471d9b77653694012435df23bd8"],
  ["af_kore", "9be5221b6a941c04b561959b8ff0b06e809444dcc4ab7e75a7b23606f691819e"],
  ["af_nicole", "cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a"],
  ["af_nova", "18778272caa0d0eebaea251c35fd635f038434f9eee5e691d02a174bd328414f"],
  ["af_river", "00a2bcf82b1d86e8f19902ede58c65ccf6c0e43b44b7d74fad54e5d8933c9c30"],
  ["af_sarah", "4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a"],
  ["af_sky", "4435255c9744f3f31659e0d714ab7689bf65d9e77ec1cce060f083912614f0b9"],
  ["am_adam", "162b035ed91cfc48b6046982184c645f72edcdd1b82843347f605d7bf7b15716"],
  ["am_echo", "3968b92c3c4cd1c4416dbded36c13eaa388a90d5788d02a13e4d781f5f8cf3c3"],
  ["am_eric", "e8b5be17edd1e3636901ce7598baafe2dc8dd8ff707a0c23bf9e461add7e2832"],
  ["am_fenrir", "c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43"],
  ["am_liam", "52403be32fd047c6a44517cb0bcd6b134f2a18baa73e70ef41651e0eab921ade"],
  ["am_michael", "1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1"],
  ["am_onyx", "da5d135b424164916d75a68ffb4c2abce3d7d5ccc82dd1ee6cf447ce286145e6"],
  ["am_puck", "fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0"],
  ["am_santa", "61150cf726ab6c5ed7a99f90a304f91f5a72c00c592e89ec94e5df11c319227a"],
  ["bf_alice", "08afa6ba24da61ea5e8efa139e5aadc938d83f0a6da5a900adaf763ac1da5573"],
  ["bf_emma", "669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73"],
  ["bf_isabella", "3754352c4aaa46d17f27654ab7518d65b62ad6163a0f55a5f4330c2da2c4e94f"],
  ["bf_lily", "5e0ee32ebe64a467124976b14e69590746f1c4ce41a12b587a50c862edfea335"],
  ["bm_daniel", "6b3194bbceffb746733cbc22c8f593dd44e401a71d53895a2dca891bc595a1e8"],
  ["bm_fable", "f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1"],
  ["bm_george", "c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc"],
  ["bm_lewis", "b8f671cef828c30e66fdf0b0756a76bba58f6bb3398cbbf27058642acbcedb97"],
  ["jf_alpha", "56b479360aad9f367aeb8cef908f9201cf48b4555e488c5f4590c9dfcd978bb6"],
  ["jf_gongitsune", "0f1181f3772d27b7c12aaf4bcd71e31b186c4146e330d074a3dc64ee392af396"],
  ["jf_nezumi", "13cb71eebb0b48739d444558322aa35a8c9a489b80e1e631f14d2e6aea93026b"],
  ["jf_tebukuro", "29c6c0561b4288d59639677bebe7533c919743d5ea68d0d2ae992644beea6696"],
  ["jm_kumo", "09e959d239724c734d65661f06f14cdabcddfd476bfaaad905a937099ae9e64f"],
  ["zf_xiaobei", "5dde6e1c9c4f12c8b327bc29c0cee361a23b52b952c04636858ba637ec66e640"],
  ["zf_xiaoni", "08892b62a39af0a615cd0581238db7e19e44c578e8fa0bfd0e586e93327d9cba"],
  ["zf_xiaoxiao", "03adb5d5e3ddd88b047954e974e651cb0a4b524c985057e5d872e962c7be1169"],
  ["zf_xiaoyi", "bc1555c5c486099196ac254bae5e0bb543c121952a3092f50b7d8724f1bc36b3"],
  ["zm_yunjian", "de48a00bdbf3649f07162269a2b6e0513604389bfac8a2e6c75cb34b323ad6fa"],
  ["zm_yunxi", "7243892fb4e560d47014090ddf010f8b8b790f3c6b029ff82b2ac06aa4e27c8b"],
  ["zm_yunxia", "6b2b8fc15b3df19a368daebe5c581c7fabf433ee5b8a17ffd6b3d723cff8936d"],
  ["zm_yunyang", "261e2c89470534dbbcb8fd98b8fdc495ec94063d9bb6c8277f7be43cccba3f42"],
  ["ef_dora", "f66ec66bd295acb18372e37008533a9a3228483ccd294e7538d5d9294ac9a532"],
  ["em_alex", "27809e9eafdcbcfff90a3016c697568676531de2a2c39cee29c96c7bd6b83e95"],
  ["em_santa", "ad43b774e1ca24d05c6161297d8aeb770ac3d29bb95daf516727af5f7d543683"],
  ["ff_siwis", "a35f5675ad08948e326ae75fd0ea16ba5d0042e4f76b5f3d1df77d0a48c54861"],
  ["hf_alpha", "040be6a4425411cc01fda5fd06693c76bfa78572632852bc8cda9c99232ffb56"],
  ["hf_beta", "cd83ae0bb9b2e4e4fb92b4973bd8d1822ca0036d3c498bf4fc89aa8e33917cc7"],
  ["hm_omega", "b02d9222d9ed00ce26b302173a862c2c93f96cc40b5c422b8d14910b9ff34137"],
  ["hm_psi", "644daf88ba8aeb7bd08950bbdcd4453bb280864e49dc4df93fabc6be32e03f37"],
  ["if_sara", "409b69248798fcdc2542330c76953d230710f19b057e59cb82fdc3c4cf71265c"],
  ["im_nicola", "bc578e510d52a96d6940d46f12e96d7b3df00905dbea075113226d100e6e1ab0"],
  ["pf_dora", "3da7b5b2d91847ebf5646f57631af6ececae3c29a89cd300f06edf9aa6cfe9ee"],
  ["pm_alex", "0175c753f59c54e7fd5a995bedef0c5ff2fb67e0043dd3dcb2ae74ec2acbeb2a"],
  ["pm_santa", "8b012db3185778afe2e45a62cbad69db73021774fe68dda634bcc748a982eede"],
];

/** Every Kokoro voice file is exactly this many bytes. */
const KOKORO_VOICE_SIZE_BYTES = 522_240;

/** Builds the pinned artifact for one Kokoro voice file. */
function kokoroVoiceArtifact(voice: string, sha256: string): PinnedArtifact {
  return {
    id: `kokoro-voice-${voice}`,
    displayName: `Kokoro voice ${voice}`,
    relativePath: `kokoro/voices/${voice}.bin`,
    url: `${HUGGINGFACE_HOST}/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${voice}.bin`,
    sha256,
    sizeBytes: KOKORO_VOICE_SIZE_BYTES,
    version: "1.0",
  };
}

/**
 * The pinned manifest. URLs/checksums are the real pinned artifacts Provisioning
 * fetches (open weights hosted on HuggingFace); bumping any of these is an explicit,
 * opt-in change (ADR-0009), never automatic. Sizes are the artifacts' real byte
 * sizes, used for the disk preflight and progress totals.
 */
export const PROVISIONING_MANIFEST: readonly ProvisionableRuntime[] = [
  {
    id: "whisper",
    displayName: "Transcription (whisper large-v3-turbo)",
    artifacts: [
      {
        id: "whisper-large-v3-turbo",
        displayName: "whisper large-v3-turbo (Metal)",
        relativePath: "whisper/ggml-large-v3-turbo.bin",
        url: `${HUGGINGFACE_HOST}/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin`,
        sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
        sizeBytes: 1_624_555_275,
        version: "1.0",
      },
    ],
  },
  {
    id: "kokoro",
    displayName: "Speech (Kokoro-82M)",
    artifacts: [
      {
        id: "kokoro-82m-onnx",
        displayName: "Kokoro-82M (ONNX)",
        relativePath: "kokoro/model.onnx",
        url: `${HUGGINGFACE_HOST}/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx`,
        sha256: "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb",
        sizeBytes: 325_532_232,
        version: "1.0",
      },
      // The 54 built-in voices, each pinned individually (no combined pack exists).
      ...KOKORO_VOICE_CHECKSUMS.map(([voice, sha256]) => kokoroVoiceArtifact(voice, sha256)),
    ],
  },
];

/** Every file artifact across all Runtimes, flattened - handy for totals and lookups. */
export function allArtifacts(manifest: readonly ProvisionableRuntime[] = PROVISIONING_MANIFEST): PinnedArtifact[] {
  return manifest.flatMap((runtime) => runtime.artifacts);
}

/** Finds a Runtime in a manifest by id. */
export function findRuntime(
  runtimeId: ProvisionableRuntimeId,
  manifest: readonly ProvisionableRuntime[] = PROVISIONING_MANIFEST,
): ProvisionableRuntime | undefined {
  return manifest.find((runtime) => runtime.id === runtimeId);
}

/** Resolves a list of Runtime ids to their manifest entries, dropping unknown ids. */
export function resolveRuntimes(
  runtimeIds: readonly ProvisionableRuntimeId[],
  manifest: readonly ProvisionableRuntime[] = PROVISIONING_MANIFEST,
): ProvisionableRuntime[] {
  return runtimeIds
    .map((runtimeId) => findRuntime(runtimeId, manifest))
    .filter((runtime): runtime is ProvisionableRuntime => runtime !== undefined);
}

/** Total bytes to download for a Runtime - the disk-space preflight input. */
export function runtimeDownloadBytes(runtime: ProvisionableRuntime): number {
  return runtime.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
}

/** Total bytes to download for a set of Runtimes - the disk-space preflight input. */
export function totalDownloadBytes(runtimes: readonly ProvisionableRuntime[]): number {
  return runtimes.reduce((sum, runtime) => sum + runtimeDownloadBytes(runtime), 0);
}
