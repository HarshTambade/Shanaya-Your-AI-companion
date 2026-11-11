import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Html, OrbitControls, useAnimations, useGLTF } from "@react-three/drei";
import { DRACOLoader, SkeletonUtils } from "three-stdlib";
import { AnimationClip, Box3, BufferGeometry, Group, Material, MathUtils, Mesh, PerspectiveCamera, Texture, Vector3 } from "three";
import type { Emotion } from "../services/LLMRouter";

const modelUrl = `${import.meta.env.BASE_URL}models/uruha_rushia_-_hololive_vtuber.glb`;
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
const emotionAliases: Record<Emotion, string[]> = {
  happy: ["happy", "smile", "joy"],
  sad: ["sad", "frown"],
  cute: ["cute", "smile", "blush"],
  neutral: [],
};
const emotionIcons: Record<Emotion, string> = { happy: "✨", sad: "💧", cute: "💗", neutral: "✦" };
const cachedSceneUsers = new WeakMap<Group, number>();

class AvatarLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed
      ? <Html center><span role="status" className="rounded-xl border border-white/10 bg-slate-950/85 px-4 py-3 text-center text-xs text-slate-200">Shanaya’s 3D model could not load. Check the model asset and refresh.</span></Html>
      : this.props.children;
  }
}

function cloneAvatarResources(scene: Group) {
  // useGLTF caches scenes globally. Clone per-instance GPU resources so unmount
  // cleanup never disposes resources used by another avatar or the GLTF cache.
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

  return () => {
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    textures.forEach((texture) => texture.dispose());
    skeletonTextures.forEach((texture) => texture.dispose());
  };
}

function retainCachedAvatarScene(scene: Group) {
  cachedSceneUsers.set(scene, (cachedSceneUsers.get(scene) ?? 0) + 1);
  return () => {
    const users = cachedSceneUsers.get(scene) ?? 1;
    if (users > 1) {
      cachedSceneUsers.set(scene, users - 1);
      return;
    }
    cachedSceneUsers.delete(scene);
    // Release Drei's shared loader cache only after other mounted clones have left.
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

function Model({ emotion }: { emotion: Emotion }) {
  const { scene, animations } = useGLTF(modelUrl, false, false, (loader) => loader.setDRACOLoader(dracoLoader));
  // SkeletonUtils preserves skinned meshes and isolates this avatar from the
  // shared GLTF scene and other mounted instances.
  const avatar = useMemo(() => SkeletonUtils.clone(scene) as Group, [scene]);
  const avatarResources = useMemo(() => ({
    dispose: cloneAvatarResources(avatar),
    disposeTimer: undefined as number | undefined,
  }), [avatar]);
  const root = useRef<Group>(null);
  const model = useRef<Group>(null);
  const modelScaleInitialized = useRef(false);
  const stableAnimations = useMemo(() => animations.map((animation) => {
    // Idle clips may key facial morphs to zero, making the face flicker or vanish.
    const tracks = animation.tracks.filter(({ name }) => !name.toLowerCase().includes("morphtargetinfluences"));
    return tracks.length === animation.tracks.length
      ? animation
      : new AnimationClip(animation.name, animation.duration, tracks, animation.blendMode);
  }), [animations]);
  const { actions } = useAnimations(stableAnimations, root);
  useEffect(() => retainCachedAvatarScene(scene), [scene]);
  const bounds = useMemo(() => {
    const box = new Box3().setFromObject(avatar);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    return {
      height: size.y,
      width: size.x,
      position: [-center.x, -box.min.y, -center.z] as [number, number, number],
    };
  }, [avatar]);

  useEffect(() => {
    avatar.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
      mesh.morphTargetInfluences.fill(0);
      const aliases = emotionAliases[emotion];
      for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
        if (aliases.some((alias) => name.toLowerCase().includes(alias))) mesh.morphTargetInfluences[index] = 1;
      }
    });
  }, [emotion, avatar]);

  useEffect(() => {
    // React StrictMode replays effects in development. Defer disposal by one
    // task and cancel it on remount so the replay cannot leave a live avatar
    // holding already-disposed GPU resources.
    if (avatarResources.disposeTimer !== undefined) {
      window.clearTimeout(avatarResources.disposeTimer);
      avatarResources.disposeTimer = undefined;
    }
    return () => {
      avatarResources.disposeTimer = window.setTimeout(() => {
        avatarResources.disposeTimer = undefined;
        avatarResources.dispose();
      }, 0);
    };
  }, [avatarResources]);

  useEffect(() => {
    const idleClip = stableAnimations.find((clip) => /idle|stand|breath/i.test(clip.name)) ?? stableAnimations[0];
    const action = idleClip ? actions[idleClip.name] : undefined;
    action?.reset().fadeIn(0.5).play();
    return () => { action?.fadeOut(0.2); };
  }, [actions, stableAnimations]);

  useFrame(({ clock, camera, size }, delta) => {
    if (!root.current) return;
    const time = clock.elapsedTime;
    const compact = size.height < 700 || size.width < 560;
    const cameraFov = (camera as PerspectiveCamera).fov;
    const viewHeight = 2 * 5.4 * Math.tan((cameraFov * Math.PI) / 360);
    const viewWidth = viewHeight * size.width / Math.max(size.height, 1);
    const heightRatio = Math.min(0.47, 390 / Math.max(size.height, 1));
    const heightFit = viewHeight * heightRatio;
    const widthFit = viewWidth * 0.78 * bounds.height / Math.max(bounds.width, 0.001);
    const fitScale = Math.min(heightFit, widthFit) / Math.max(bounds.height, 0.001);
    const avatar = root.current;

    avatar.position.x = Math.sin(time * 0.42) * 0.065;
    avatar.position.y = (compact ? 0.72 : 0.52) + Math.sin(time * 1.25) * 0.055;
    avatar.rotation.x = MathUtils.damp(avatar.rotation.x, Math.sin(time * 0.52) * 0.035, 3.5, delta);
    avatar.rotation.y = MathUtils.damp(avatar.rotation.y, Math.sin(time * 0.34) * 0.14, 2.8, delta);
    avatar.rotation.z = MathUtils.damp(avatar.rotation.z, Math.sin(time * 0.68) * 0.035, 3.5, delta);

    if (model.current) {
      const breath = Math.sin(time * 1.8) * 0.012;
      const sx = fitScale * (1 + breath * 0.5);
      const sy = fitScale * (1 + breath);
      const sz = fitScale * (1 + breath * 0.5);
      if (!modelScaleInitialized.current) {
        model.current.scale.set(sx, sy, sz);
        modelScaleInitialized.current = true;
      } else {
        model.current.scale.x = MathUtils.damp(model.current.scale.x, sx, 4, delta);
        model.current.scale.y = MathUtils.damp(model.current.scale.y, sy, 4, delta);
        model.current.scale.z = MathUtils.damp(model.current.scale.z, sz, 4, delta);
      }
    }
  });

  return (
    <group ref={root}>
      <group ref={model} position={bounds.position}>
        {/* Per-instance geometry/material/texture clones are disposed on unmount. */}
        <primitive object={avatar} dispose={null} />
        <Html position={[0.42, bounds.height * 0.92, 0.12]} center distanceFactor={7} zIndexRange={[10, 0]}>
          <span aria-label={`Shanaya feels ${emotion}`} className="rounded-full border border-white/15 bg-slate-950/80 px-2 py-1 text-sm shadow-lg backdrop-blur">{emotionIcons[emotion]}</span>
        </Html>
      </group>
    </group>
  );
}

export default function Avatar({ emotion }: { emotion: Emotion }) {
  return (
    <div className="h-full w-full">
      <Canvas
        camera={{ position: [0, 1.1, 5.4], fov: 35 }}
        dpr={[1, 2]}
        gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
        onCreated={({ gl }) => gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))}
      >
        <ambientLight intensity={1.7} />
        <directionalLight position={[3, 5, 4]} intensity={2.5} color="#fff2df" />
        <directionalLight position={[-4, 2, -3]} intensity={1.8} color="#a6a5ff" />
        <AvatarLoadBoundary>
          <Suspense fallback={<Html center><span className="text-xs text-slate-400">Preparing Shanaya…</span></Html>}>
            <Model emotion={emotion} />
          </Suspense>
        </AvatarLoadBoundary>
        <OrbitControls target={[0, 1.1, 0]} enablePan={false} enableDamping dampingFactor={0.08} minDistance={3.4} maxDistance={7.5} minPolarAngle={Math.PI / 3.4} maxPolarAngle={Math.PI / 1.9} />
      </Canvas>
    </div>
  );
}

useGLTF.preload(modelUrl, false, false, (loader) => loader.setDRACOLoader(dracoLoader));
