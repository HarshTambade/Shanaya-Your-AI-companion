import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Html, OrbitControls, useAnimations, useGLTF } from "@react-three/drei";
import { DRACOLoader } from "three-stdlib";
import { Box3, Group, MathUtils, Mesh, PerspectiveCamera, Vector3 } from "three";
import type { Emotion } from "../services/LLMRouter";

const modelUrl = "/models/avatar.glb";
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("/draco/");
const emotionAliases: Record<Emotion, string[]> = {
  happy: ["happy", "smile", "joy"],
  sad: ["sad", "frown"],
  angry: ["angry", "mad", "browdown"],
  cute: ["cute", "smile", "blush"],
  neutral: [],
};
const emotionIcons: Record<Emotion, string> = { happy: "✨", sad: "💧", angry: "🔥", cute: "💗", neutral: "✦" };

function Model({ emotion }: { emotion: Emotion }) {
  const { scene, animations } = useGLTF(modelUrl, false, false, (loader) => loader.setDRACOLoader(dracoLoader));
  const root = useRef<Group>(null);
  const model = useRef<Group>(null);
  const modelScaleInitialized = useRef(false);
  const { actions } = useAnimations(animations, root);
  const bounds = useMemo(() => {
    const box = new Box3().setFromObject(scene);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    return {
      height: size.y,
      width: size.x,
      position: [-center.x, -box.min.y, -center.z] as [number, number, number],
    };
  }, [scene]);

  useEffect(() => {
    scene.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
      mesh.morphTargetInfluences.fill(0);
      const aliases = emotionAliases[emotion];
      for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
        if (aliases.some((alias) => name.toLowerCase().includes(alias))) mesh.morphTargetInfluences[index] = 1;
      }
    });
  }, [emotion, scene]);

  useEffect(() => {
    const idleClip = animations.find((clip) => /idle|stand|breath/i.test(clip.name)) ?? animations[0];
    const action = idleClip ? actions[idleClip.name] : undefined;
    action?.reset().fadeIn(0.5).play();
    return () => { action?.fadeOut(0.2); };
  }, [actions, animations]);

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
        <primitive object={scene} />
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
        <Suspense fallback={<Html center><span className="text-xs text-slate-400">Preparing Shanaya…</span></Html>}>
          <Model emotion={emotion} />
        </Suspense>
        <OrbitControls target={[0, 1.1, 0]} enablePan={false} enableDamping dampingFactor={0.08} minDistance={3.4} maxDistance={7.5} minPolarAngle={Math.PI / 3.4} maxPolarAngle={Math.PI / 1.9} />
      </Canvas>
    </div>
  );
}

useGLTF.preload(modelUrl, false, false, (loader) => loader.setDRACOLoader(dracoLoader));
