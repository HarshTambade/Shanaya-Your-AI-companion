import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls, useAnimations, useGLTF, useProgress } from "@react-three/drei";
import { AnimationClip, Box3, BufferGeometry, Group, Material, MathUtils, Mesh, PerspectiveCamera, Texture, Vector3 } from "three";
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
dracoLoader.setDecoderPath("/draco/");
const avatarModelUrl = import.meta.env.VITE_AVATAR_MODEL_URL?.trim() || "/models/avatar.draco.glb";

export type AvatarMotion = "loading" | "animation" | "procedural";

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
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
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
    },
  };
}

function Avatar({ emotion, onMotionChange }: { emotion: Emotion; onMotionChange?: (motion: AvatarMotion) => void }) {
  const { scene, animations } = useGLTF(avatarModelUrl, false, false, (loader) => loader.setDRACOLoader(dracoLoader));
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

  useEffect(() => {
    applyEmotionMorph(avatar, emotion);
    emotionPulse.current = 0;
  }, [emotion, avatar]);

  useEffect(() => {
    return cloneAvatarResources(avatar).dispose;
  }, [avatar]);

  const framing = useMemo(() => {
    const bounds = new Box3().setFromObject(avatar);
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
    // The canvas sits between the avatar header and status cards, so let the model
    // use most of that available area while preserving a small safety margin.
    const heightFraction = Math.min(0.92, 980 / Math.max(1, size.height));
    const heightLimit = viewHeight * heightFraction;
    const widthLimit = viewWidth * 0.78 * (framing.sourceHeight / Math.max(framing.sourceWidth, 0.001));
    const fitScale = Math.min(heightLimit, widthLimit) / Math.max(framing.sourceHeight, 0.001);
    avatar.position.x = Math.sin(time * 0.42) * 0.095;
    const fittedAvatarHeight = fitScale * framing.sourceHeight;
    avatar.position.y = 1.1 - fittedAvatarHeight / 2 + Math.sin(time * 1.25) * 0.075 + pose.bounce * pulse;
    avatar.rotation.x = MathUtils.damp(avatar.rotation.x, pose.lean + Math.sin(time * 0.52) * 0.045, 3.5, delta);
    avatar.rotation.y = MathUtils.damp(avatar.rotation.y, pose.turn + Math.sin(time * 0.34) * 0.19, 2.8, delta);
    avatar.rotation.z = MathUtils.damp(avatar.rotation.z, pose.tilt + Math.sin(time * 0.68) * 0.045, 3.5, delta);
    const scale = 1 + (emotion === "surprised" ? 0.035 : 0.012) * pulse;
    avatar.scale.setScalar(MathUtils.damp(avatar.scale.x, scale, 4, delta));

    if (modelGroup) {
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
      <group ref={model} position={framing.position}>
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

export default function AvatarScene({ emotion, onMotionChange }: { emotion: Emotion; onMotionChange?: (motion: AvatarMotion) => void }) {
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
          <Avatar emotion={emotion} onMotionChange={onMotionChange} />
        </Suspense>
        <OrbitControls
          target={[0, 1.1, 0]}
          enablePan={false}
          enableDamping
          dampingFactor={0.08}
          // Keep the face oriented toward the conversation while still allowing
          // a small amount of interactive viewing and zoom.
          minAzimuthAngle={-Math.PI / 7}
          maxAzimuthAngle={Math.PI / 7}
          minDistance={4.8}
          maxDistance={6.2}
          minPolarAngle={Math.PI / 3.4}
          maxPolarAngle={Math.PI / 1.9}
        />
      </Canvas>
    </div>
  );
}

useGLTF.preload(avatarModelUrl, false, false, (loader) => loader.setDRACOLoader(dracoLoader));
