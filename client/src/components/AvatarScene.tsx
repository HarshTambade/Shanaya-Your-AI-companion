import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, useAnimations, useGLTF, useProgress } from "@react-three/drei";
import { AnimationClip, Box3, BufferGeometry, Group, Material, MathUtils, Mesh, PerspectiveCamera, SkinnedMesh, Texture, Vector3 } from "three";
import { DRACOLoader, SkeletonUtils } from "three-stdlib";
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

const emotionPose: Record<Emotion, { lean: number; turn: number; tilt: number; bounce: number }> = {
  happy: { lean: -0.045, turn: 0.14, tilt: -0.04, bounce: 0.13 },
  sad: { lean: 0.14, turn: -0.08, tilt: 0.06, bounce: -0.07 },
  angry: { lean: -0.06, turn: 0.05, tilt: -0.09, bounce: 0.02 },
  neutral: { lean: 0, turn: 0, tilt: 0, bounce: 0 },
  surprised: { lean: -0.12, turn: 0, tilt: 0, bounce: 0.16 },
  thinking: { lean: -0.04, turn: -0.22, tilt: 0.08, bounce: 0.015 },
};

const dracoLoader = new DRACOLoader();
const publicBaseUrl = import.meta.env.BASE_URL;
dracoLoader.setDecoderPath(`${publicBaseUrl}draco/`);
const configuredAvatarModelUrl = import.meta.env.VITE_AVATAR_MODEL_URL?.trim();
const avatarModelUrl = configuredAvatarModelUrl || `${publicBaseUrl}models/uruha_rushia_-_hololive_vtuber.glb`;
const uncompressedAvatarModelUrl = `${publicBaseUrl}models/avatar.glb`;
const cachedSceneUsers = new WeakMap<Group, number>();

export type AvatarMotion = "loading" | "animation" | "procedural" | "error";

class AvatarLoadBoundary extends Component<{
  children: ReactNode;
  fallback: ReactNode;
  onError?: () => void;
}, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch() {
    this.props.onError?.();
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

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

function cloneAvatarResources(scene: Group) {
  // useGLTF caches its scene globally. Give the mounted instance independent
  // GPU resources; cleanup can then dispose these without touching that cache.
  const geometries = new Map<BufferGeometry, BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Map<Texture, Texture>();
  const skeletonTextures = new Set<Texture>();
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const skeletonTexture = (object as Mesh & { skeleton?: { boneTexture?: Texture } }).skeleton?.boneTexture;
    if (skeletonTexture) skeletonTextures.add(skeletonTexture);
    const geometry = geometries.get(object.geometry) ?? object.geometry.clone();
    geometries.set(object.geometry, geometry);
    object.geometry = geometry;

    const cloneMaterial = (material: Material) => {
      const clone = material.clone();
      materials.add(clone);
      for (const [key, value] of Object.entries(clone as unknown as Record<string, unknown>)) {
        if (!(value instanceof Texture)) continue;
        let texture = textures.get(value);
        if (!texture) {
          texture = value.clone();
          texture.needsUpdate = true;
          textures.set(value, texture);
        }
        (clone as unknown as Record<string, unknown>)[key] = texture;
      }
      return clone;
    };
    object.material = Array.isArray(object.material)
      ? object.material.map(cloneMaterial)
      : cloneMaterial(object.material);
  });

  return {
    dispose() {
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      textures.forEach((texture) => texture.dispose());
      skeletonTextures.forEach((texture) => texture.dispose());
    },
  };
}

function retainCachedAvatarScene(modelUrl: string, scene: Group) {
  cachedSceneUsers.set(scene, (cachedSceneUsers.get(scene) ?? 0) + 1);
  return () => {
    const users = cachedSceneUsers.get(scene) ?? 1;
    if (users > 1) {
      cachedSceneUsers.set(scene, users - 1);
      return;
    }
    cachedSceneUsers.delete(scene);
    // Defer cache release by one task so React StrictMode's development-only
    // mount/cleanup/remount cycle can reclaim the scene before it is disposed.
    setTimeout(() => {
      if (cachedSceneUsers.has(scene)) return;
      useGLTF.clear(modelUrl);
      const geometries = new Set<BufferGeometry>();
      const materials = new Set<Material>();
      const textures = new Set<Texture>();
      scene.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        geometries.add(object.geometry);
        const skeletonTexture = (object as Mesh & { skeleton?: { boneTexture?: Texture } }).skeleton?.boneTexture;
        if (skeletonTexture) textures.add(skeletonTexture);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          materials.add(material);
          for (const value of Object.values(material as unknown as Record<string, unknown>)) {
            if (value instanceof Texture) textures.add(value);
          }
        }
      });
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      textures.forEach((texture) => texture.dispose());
    }, 0);
  };
}

function Avatar({ emotion, onMotionChange, modelUrl }: { emotion: Emotion; onMotionChange?: (motion: AvatarMotion) => void; modelUrl: string }) {
  const { scene, animations } = useGLTF(modelUrl, false, false, (loader) => loader.setDRACOLoader(dracoLoader));
  // Keep the render-time clone CPU-only; clone GPU resources in the effect so
  // StrictMode's intentional double render cannot leak discarded resources.
  const avatar = useMemo(() => SkeletonUtils.clone(scene) as Group, [scene]);
  const group = useRef<Group>(null);
  const model = useRef<Group>(null);
  const modelScaleInitialized = useRef(false);
  const emotionPulse = useRef(0);
  const stableAnimations = useMemo(() => animations.map((animation) => {
    // The GLB's Idle clip animates all three face morph meshes plus the eye,
    // head, and neck tracks. Those keys make the facial features disappear at
    // some frames, so keep the body/hair/clothing motion and hold the face still.
    const tracks = animation.tracks.filter(({ name }) => {
      const trackName = name.toLowerCase();
      return !trackName.includes("morphtargetinfluences")
        && !/^(head_09|neck_08|eye_l_018|eye_r_019)\./.test(trackName);
    });
    return tracks.length === animation.tracks.length
      ? animation
      : new AnimationClip(animation.name, animation.duration, tracks, animation.blendMode);
  }), [animations]);
  const { actions } = useAnimations(stableAnimations, group);
  const { camera, size } = useThree();

  useEffect(() => retainCachedAvatarScene(modelUrl, scene), [modelUrl, scene]);

  useEffect(() => {
    applyEmotionMorph(avatar, emotion);
    emotionPulse.current = 0;
  }, [emotion, avatar]);

  useEffect(() => {
    return cloneAvatarResources(avatar).dispose;
  }, [avatar]);

  const framing = useMemo(() => {
    // Include deformed skin vertices: the GLB's undeformed geometry bounds are
    // much smaller than the visible character and crop the head when fitted.
    avatar.updateMatrixWorld(true);
    avatar.traverse((object) => {
      if ((object as SkinnedMesh).isSkinnedMesh) (object as SkinnedMesh).skeleton.update();
    });
    const bounds = new Box3().setFromObject(avatar, true);
    const modelSize = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());
    return {
      sourceHeight: modelSize.y,
      sourceWidth: modelSize.x,
      position: [-center.x, -bounds.min.y, -center.z] as [number, number, number],
    };
  }, [avatar]);

  useEffect(() => {
    const idleAnimation = stableAnimations.find((animation) => /idle|stand|breath/i.test(animation.name)) ?? stableAnimations[0];
    const firstAction = idleAnimation ? actions[idleAnimation.name] : undefined;
    firstAction?.reset().fadeIn(0.5).play();
    onMotionChange?.(firstAction ? "animation" : "procedural");
    return () => {
      firstAction?.fadeOut(0.25);
    };
  }, [actions, stableAnimations, onMotionChange]);

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
    // Leave a generous margin: skinned hair, clothing, and idle motion can extend
    // beyond the static pose bounds, so fitting right to the edge clips the model.
    const heightFraction = 0.76;
    const heightLimit = viewHeight * heightFraction;
    const widthLimit = viewWidth * 0.78 * (framing.sourceHeight / Math.max(framing.sourceWidth, 0.001));
    const fitScale = Math.min(heightLimit, widthLimit) / Math.max(framing.sourceHeight, 0.001);
    // Keep the character's center fixed. The previous lateral sway and broad
    // yaw made this tall model appear to travel across the entire stage.
    avatar.position.x = 0;
    const fittedAvatarHeight = fitScale * framing.sourceHeight;
    avatar.position.y = 1.1 - fittedAvatarHeight / 2 + Math.sin(time * 1.25) * 0.045 + pose.bounce * pulse;
    avatar.rotation.x = MathUtils.damp(avatar.rotation.x, pose.lean + Math.sin(time * 0.52) * 0.045, 3.5, delta);
    const subtleTurn = MathUtils.clamp(pose.turn * 0.2 + Math.sin(time * 0.34) * 0.025, -0.06, 0.06);
    avatar.rotation.y = MathUtils.damp(avatar.rotation.y, subtleTurn, 2.8, delta);
    avatar.rotation.z = MathUtils.damp(avatar.rotation.z, pose.tilt + Math.sin(time * 0.68) * 0.045, 3.5, delta);
    const scale = 1 + (emotion === "surprised" ? 0.035 : 0.012) * pulse;
    avatar.scale.setScalar(MathUtils.damp(avatar.scale.x, scale, 4, delta));

    if (modelGroup) {
      // The source model has a large off-origin transform. Apply its centering
      // offset in the same scaled coordinate space, or the avatar lands far
      // outside the camera frustum while its animation still appears active.
      modelGroup.position.set(
        framing.position[0] * fitScale,
        framing.position[1] * fitScale,
        framing.position[2] * fitScale,
      );
      const breath = Math.sin(time * 1.8) * 0.016;
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
      <group ref={model}>
        <primitive object={avatar} dispose={null} />
      </group>
    </group>
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

function SceneError({ onMotionChange }: { onMotionChange?: (motion: AvatarMotion) => void }) {
  useEffect(() => onMotionChange?.("error"), [onMotionChange]);
  return (
    <Html center>
      <div className="w-64 rounded-xl border border-rose-300/15 bg-[#0c101b]/90 px-4 py-3 text-center shadow-xl">
        <p className="text-xs font-semibold text-slate-200">Avatar could not be displayed</p>
        <p className="mt-1 text-[10px] leading-relaxed text-slate-400">Refresh the page to try loading the model again.</p>
      </div>
    </Html>
  );
}

export default function AvatarScene({ emotion, onMotionChange }: { emotion: Emotion; onMotionChange?: (motion: AvatarMotion) => void }) {
  const [useUncompressedModel, setUseUncompressedModel] = useState(false);
  const canFallback = !configuredAvatarModelUrl && avatarModelUrl !== uncompressedAvatarModelUrl;
  const modelUrl = useUncompressedModel ? uncompressedAvatarModelUrl : avatarModelUrl;

  return (
    <div className="relative h-full w-full">
      <Canvas
        camera={{ position: [0, 1.1, 5.4], fov: 35 }}
        dpr={[1, 2]}
        gl={{ alpha: true, antialias: true }}
        onCreated={({ gl, camera }) => {
          gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
          gl.setClearColor("#000000", 0);
          camera.position.set(0, 1.1, 5.4);
          camera.lookAt(0, 1.1, 0);
          camera.updateProjectionMatrix();
        }}
      >
        <ambientLight intensity={1.8} />
        <directionalLight position={[3, 5, 4]} intensity={3.1} color="#fff2df" />
        <directionalLight position={[-4, 2, -3]} intensity={2.2} color="#a6a5ff" />
        <pointLight position={[0, 1.8, 2.5]} intensity={0.95} color={emotionLight[emotion]} />
        <AvatarLoadBoundary
          key={modelUrl}
          onError={canFallback && !useUncompressedModel ? () => setUseUncompressedModel(true) : undefined}
          fallback={<SceneError onMotionChange={onMotionChange} />}
        >
          <Suspense fallback={<SceneLoader />}>
            <Avatar emotion={emotion} onMotionChange={onMotionChange} modelUrl={modelUrl} />
          </Suspense>
        </AvatarLoadBoundary>
      </Canvas>
    </div>
  );
}

useGLTF.preload(avatarModelUrl, false, false, (loader) => loader.setDRACOLoader(dracoLoader));
