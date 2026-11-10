import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Html, OrbitControls, Stats, useAnimations, useGLTF, useProgress } from "@react-three/drei";
import { Box3, FloatType, Group, HalfFloatType, MathUtils, Mesh, PerspectiveCamera, RedFormat, RGBAFormat, RGBFormat, RGFormat, Scene, Texture, Vector3 } from "three";
import { DRACOLoader } from "three-stdlib";
import type { Emotion } from "../types";

const emotionMorphs: Record<Emotion, string[]> = {
  happy: ["happy", "smile", "joy"],
  sad: ["sad", "frown", "mouthfrown"],
  angry: ["angry", "browdown", "mad"],
  neutral: [],
  surprised: ["surprise", "wideeyes", "jawopen"],
  thinking: ["thinking", "ponder", "browinnerup"],
};

const emotionLight: Record<Emotion, string> = {
  happy: "#fbbf24",
  sad: "#60a5fa",
  angry: "#fb7185",
  neutral: "#a78bfa",
  surprised: "#fb923c",
  thinking: "#c084fc",
};

const emotionIcon: Record<Emotion, string> = {
  happy: "✨",
  sad: "💧",
  angry: "🔥",
  neutral: "✦",
  surprised: "❕",
  thinking: "💭",
};

const emotionPose: Record<Emotion, { lean: number; turn: number; tilt: number; bounce: number }> = {
  happy: { lean: -0.025, turn: 0.08, tilt: -0.025, bounce: 0.09 },
  sad: { lean: 0.09, turn: -0.04, tilt: 0.035, bounce: -0.04 },
  angry: { lean: -0.035, turn: 0.025, tilt: -0.055, bounce: 0.015 },
  neutral: { lean: 0, turn: 0, tilt: 0, bounce: 0 },
  surprised: { lean: -0.075, turn: 0, tilt: 0, bounce: 0.12 },
  thinking: { lean: -0.025, turn: -0.16, tilt: 0.045, bounce: 0.01 },
};

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("/draco/");
const avatarModelUrl = import.meta.env.VITE_AVATAR_MODEL_URL?.trim() || "/models/avatar.glb";

function applyEmotionMorph(scene: Group | Mesh, emotion: Emotion) {
  const aliases = emotionMorphs[emotion];
  scene.traverse((object) => {
    const mesh = object as Mesh;
    const dictionary = mesh.morphTargetDictionary;
    const influences = mesh.morphTargetInfluences;
    if (!dictionary || !influences) return;

    influences.fill(0);
    for (const [name, index] of Object.entries(dictionary)) {
      if (aliases.some((alias) => name.toLowerCase().includes(alias))) influences[index] = 1;
    }
  });
}

function Avatar({ emotion }: { emotion: Emotion }) {
  const { scene, animations } = useGLTF(avatarModelUrl, false, false, (loader) => loader.setDRACOLoader(dracoLoader));
  const group = useRef<Group>(null);
  const model = useRef<Group>(null);
  const modelScaleInitialized = useRef(false);
  const emotionPulse = useRef(0);
  const { actions } = useAnimations(animations, group);
  const { camera, size } = useThree();

  useEffect(() => {
    applyEmotionMorph(scene, emotion);
    emotionPulse.current = 0;
  }, [emotion, scene]);

  const framing = useMemo(() => {
    const bounds = new Box3().setFromObject(scene);
    const modelSize = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());
    return {
      sourceHeight: modelSize.y,
      sourceWidth: modelSize.x,
      position: [-center.x, -bounds.min.y, -center.z] as [number, number, number],
    };
  }, [scene]);

  useEffect(() => {
    const idleAnimation = animations.find((animation) => /idle|stand|breath/i.test(animation.name)) ?? animations[0];
    const firstAction = idleAnimation ? actions[idleAnimation.name] : undefined;
    firstAction?.reset().fadeIn(0.5).play();
    return () => {
      firstAction?.fadeOut(0.25);
    };
  }, [actions, animations]);

  useFrame(({ clock }, delta) => {
    if (!group.current) return;

    // Keep the fallback motion visible even when the GLB has no animation clips.
    emotionPulse.current += delta;
    const pulse = Math.exp(-emotionPulse.current * 3.2);
    const pose = emotionPose[emotion];
    const time = clock.elapsedTime;
    const avatar = group.current;
    const modelGroup = model.current;
    const perspectiveCamera = camera as PerspectiveCamera;
    const viewHeight = 2 * 5.4 * Math.tan((perspectiveCamera.fov * Math.PI) / 360);
    const aspect = size.width / Math.max(1, size.height);
    const viewWidth = viewHeight * aspect;
    const heightFraction = Math.min(0.54, 420 / Math.max(1, size.height));
    const heightLimit = viewHeight * heightFraction;
    const widthLimit = viewWidth * 0.82 * (framing.sourceHeight / Math.max(framing.sourceWidth, 0.001));
    const fitScale = Math.min(heightLimit, widthLimit) / Math.max(framing.sourceHeight, 0.001);
    const compactViewport = size.height < 700 || size.width < 560;

    avatar.position.x = Math.sin(time * 0.42) * 0.045;
    avatar.position.y = (compactViewport ? 0.58 : 0.4) + Math.sin(time * 1.25) * 0.04 + pose.bounce * pulse;
    avatar.rotation.x = MathUtils.damp(avatar.rotation.x, pose.lean + Math.sin(time * 0.52) * 0.025, 3.5, delta);
    avatar.rotation.y = MathUtils.damp(avatar.rotation.y, pose.turn + Math.sin(time * 0.34) * 0.09, 2.8, delta);
    avatar.rotation.z = MathUtils.damp(avatar.rotation.z, pose.tilt + Math.sin(time * 0.68) * 0.025, 3.5, delta);
    const scale = 1 + (emotion === "surprised" ? 0.035 : 0.012) * pulse;
    avatar.scale.setScalar(MathUtils.damp(avatar.scale.x, scale, 4, delta));

    if (modelGroup) {
      const breath = Math.sin(time * 1.8) * 0.008;
      const nextX = fitScale * (1 + breath * 0.5);
      const nextY = fitScale * (1 + breath);
      const nextZ = fitScale * (1 + breath * 0.5);
      if (!modelScaleInitialized.current) {
        modelGroup.scale.set(nextX, nextY, nextZ);
        modelScaleInitialized.current = true;
      } else {
        modelGroup.scale.x = MathUtils.damp(modelGroup.scale.x, nextX, 4, delta);
        modelGroup.scale.y = MathUtils.damp(modelGroup.scale.y, nextY, 4, delta);
        modelGroup.scale.z = MathUtils.damp(modelGroup.scale.z, nextZ, 4, delta);
      }
    }
  });

  return (
    <group ref={group}>
      <group ref={model} position={framing.position}>
        <primitive object={scene} />
        <Html position={[0.42, framing.sourceHeight * 0.9, 0.12]} center distanceFactor={7} zIndexRange={[20, 0]}>
          <div key={emotion} className="avatar-emotion-bubble" aria-label={`Shanaya feels ${emotion}`} title={emotion}>
            {emotionIcon[emotion]}
          </div>
        </Html>
      </group>
    </group>
  );
}

const drawCallBudget = 150;
const textureCountBudget = 64;
const textureMemoryBudgetBytes = 128 * 1024 * 1024;

function estimateTextureMemory(scene: Scene) {
  const textures = new Set<Texture>();
  const textureSlots = [
    "map", "alphaMap", "aoMap", "bumpMap", "displacementMap", "emissiveMap", "envMap",
    "lightMap", "metalnessMap", "normalMap", "roughnessMap", "specularMap",
  ];

  if (scene.environment?.isTexture) textures.add(scene.environment);
  const backgroundTexture = scene.background as Texture | null;
  if (backgroundTexture?.isTexture) textures.add(backgroundTexture);
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    for (const material of (Array.isArray(mesh.material) ? mesh.material : [mesh.material])) {
      for (const slot of textureSlots) {
        const texture = (material as unknown as Record<string, unknown>)[slot] as Texture | undefined;
        if (texture?.isTexture) textures.add(texture);
      }
    }
  });

  let bytes = 0;
  for (const texture of textures) {
    const mipmaps = texture.mipmaps as Array<{ data?: ArrayBufferView }> | undefined;
    const mipmapBytes = mipmaps?.reduce((sum, mipmap) => {
      const data = mipmap.data;
      return sum + (data?.byteLength ?? 0);
    }, 0) ?? 0;
    if (mipmapBytes > 0) {
      bytes += mipmapBytes;
      continue;
    }

    const estimateImageBytes = (image: unknown): number => {
      if (Array.isArray(image)) return image.reduce((sum, face) => sum + estimateImageBytes(face), 0);
      if (!image || typeof image !== "object") return 0;
      const size = image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number };
      const width = size.width ?? size.naturalWidth ?? size.videoWidth ?? 0;
      const height = size.height ?? size.naturalHeight ?? size.videoHeight ?? 0;
      if (!width || !height) return 0;
      const components = texture.format === RGBAFormat ? 4 : texture.format === RGBFormat ? 3 : texture.format === RGFormat ? 2 : texture.format === RedFormat ? 1 : 4;
      const bytesPerComponent = texture.type === FloatType ? 4 : texture.type === HalfFloatType ? 2 : 1;
      const mipFactor = texture.generateMipmaps ? 4 / 3 : 1;
      return width * height * components * bytesPerComponent * mipFactor;
    };
    bytes += estimateImageBytes(texture.image);
  }
  return bytes;
}

function RendererBudgetMonitor() {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const [metrics, setMetrics] = useState({ calls: 0, textures: 0, textureBytes: 0 });
  const overDrawBudget = useRef(false);
  const overTextureBudget = useRef(false);
  const overMemoryBudget = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const calls = gl.info.render.calls;
      const textures = gl.info.memory.textures;
      const textureBytes = estimateTextureMemory(scene);
      setMetrics({ calls, textures, textureBytes });

      if (calls > drawCallBudget && !overDrawBudget.current) {
        console.warn(`[avatar] Draw-call budget exceeded (${calls}/${drawCallBudget}).`);
        overDrawBudget.current = true;
      } else if (calls <= drawCallBudget) {
        overDrawBudget.current = false;
      }
      if (textures > textureCountBudget && !overTextureBudget.current) {
        console.warn(`[avatar] Texture-count budget exceeded (${textures}/${textureCountBudget}).`);
        overTextureBudget.current = true;
      } else if (textures <= textureCountBudget) {
        overTextureBudget.current = false;
      }
      if (textureBytes > textureMemoryBudgetBytes && !overMemoryBudget.current) {
        console.warn(`[avatar] Estimated texture-memory budget exceeded (${(textureBytes / (1024 * 1024)).toFixed(1)} MiB/${textureMemoryBudgetBytes / (1024 * 1024)} MiB).`);
        overMemoryBudget.current = true;
      } else if (textureBytes <= textureMemoryBudgetBytes) {
        overMemoryBudget.current = false;
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [gl, scene]);

  return (
    <Html fullscreen zIndexRange={[5, 0]}>
      <div className="pointer-events-none absolute right-3 top-3 rounded-lg border border-white/10 bg-slate-950/75 px-2.5 py-2 font-mono text-[9px] leading-relaxed text-slate-300 shadow-lg backdrop-blur">
        <div>DRAW CALLS&nbsp; {metrics.calls} / {drawCallBudget}</div>
        <div>TEXTURES&nbsp;&nbsp;&nbsp;&nbsp; {metrics.textures} / {textureCountBudget}</div>
        <div>TEXTURE MEM&nbsp; {(metrics.textureBytes / (1024 * 1024)).toFixed(1)} / {textureMemoryBudgetBytes / (1024 * 1024)} MiB</div>
      </div>
    </Html>
  );
}

function SceneLoader() {
  const { progress } = useProgress();
  return (
    <Html center>
      <div className="w-44 text-center">
        <div className="mx-auto mb-3 h-1 w-36 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-violet-400 transition-all" style={{ width: `${progress}%` }} />
        </div>
        <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-slate-400">Preparing your space · {Math.round(progress)}%</p>
      </div>
    </Html>
  );
}

export default function AvatarScene({ emotion }: { emotion: Emotion }) {
  return (
    <div className="relative h-full w-full">
      <Canvas
        camera={{ position: [0, 1.1, 5.4], fov: 35 }}
        dpr={[1, 2]}
        gl={{ alpha: true, antialias: true }}
        onCreated={({ gl }) => gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))}
      >
        <ambientLight intensity={1.8} />
        <directionalLight position={[3, 5, 4]} intensity={3.1} color="#fff2df" />
        <directionalLight position={[-4, 2, -3]} intensity={2.2} color="#a6a5ff" />
        <pointLight position={[0, 1.8, 2.5]} intensity={0.95} color={emotionLight[emotion]} />
        <Suspense fallback={<SceneLoader />}>
          <Avatar emotion={emotion} />
          <Environment preset="studio" />
        </Suspense>
        {import.meta.env.DEV && <><Stats /> <RendererBudgetMonitor /></>}
        <OrbitControls
          target={[0, 1.1, 0]}
          enablePan={false}
          enableDamping
          dampingFactor={0.08}
          minDistance={3.4}
          maxDistance={7}
          minPolarAngle={Math.PI / 3.4}
          maxPolarAngle={Math.PI / 1.9}
        />
      </Canvas>
      <div
        aria-label={`Avatar emotion: ${emotion}`}
        title={`Shanaya is feeling ${emotion}`}
        className="pointer-events-none absolute right-4 top-20 z-10 flex items-center gap-2 rounded-full border border-white/10 bg-[#101522]/80 px-3 py-2 text-xs capitalize text-slate-200 shadow-lg backdrop-blur-md md:right-7 md:top-24"
      >
        <span className="text-sm" aria-hidden="true">{emotionIcon[emotion]}</span>
        <span>{emotion}</span>
      </div>
    </div>
  );
}

useGLTF.preload(avatarModelUrl, false, false, (loader) => loader.setDRACOLoader(dracoLoader));
