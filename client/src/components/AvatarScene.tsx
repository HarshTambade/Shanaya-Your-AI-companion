import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Html, OrbitControls, useAnimations, useGLTF, useProgress } from "@react-three/drei";
import { Box3, Group, Mesh, Vector3 } from "three";
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
  const { scene, animations } = useGLTF("/models/avatar.glb");
  const group = useRef<Group>(null);
  const { actions } = useAnimations(animations, group);

  useEffect(() => {
    applyEmotionMorph(scene, emotion);
  }, [emotion, scene]);

  const framing = useMemo(() => {
    const bounds = new Box3().setFromObject(scene);
    const size = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());
    const scale = size.y > 0 ? 3.15 / size.y : 1;
    return {
      scale,
      position: [-center.x * scale, -bounds.min.y * scale, -center.z * scale] as [number, number, number],
    };
  }, [scene]);

  useEffect(() => {
    const firstAction = animations.length ? actions[animations[0].name] : undefined;
    firstAction?.reset().fadeIn(0.5).play();
    return () => {
      firstAction?.fadeOut(0.25);
    };
  }, [actions, animations]);

  useFrame(({ clock }) => {
    if (!animations.length && group.current) {
      group.current.position.y = framing.position[1] + Math.sin(clock.elapsedTime * 1.1) * 0.035;
    }
  });

  return (
    <group ref={group}>
      <group position={framing.position} scale={framing.scale}>
        <primitive object={scene} />
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

export default function AvatarScene({ emotion }: { emotion: Emotion }) {
  return (
    <div className="relative h-full w-full">
      <Canvas camera={{ position: [0, 1.5, 4.8], fov: 34 }} dpr={[1, 1.75]} gl={{ alpha: true, antialias: true }}>
        <ambientLight intensity={1.8} />
        <directionalLight position={[3, 5, 4]} intensity={3.1} color="#fff2df" />
        <directionalLight position={[-4, 2, -3]} intensity={2.2} color="#a6a5ff" />
        <pointLight position={[0, 1.8, 2.5]} intensity={0.95} color={emotionLight[emotion]} />
        <Suspense fallback={<SceneLoader />}>
          <Avatar emotion={emotion} />
          <Environment preset="studio" />
        </Suspense>
        <OrbitControls
          target={[0, 1.15, 0]}
          enablePan={false}
          enableDamping
          dampingFactor={0.08}
          minDistance={2.2}
          maxDistance={7}
          minPolarAngle={Math.PI / 3.4}
          maxPolarAngle={Math.PI / 1.9}
        />
      </Canvas>
      <div
        aria-label={`Avatar emotion: ${emotion}`}
        title={`Shanaya is feeling ${emotion}`}
        className="pointer-events-none absolute bottom-5 right-5 z-10 flex items-center gap-2 rounded-full border border-white/10 bg-[#101522]/80 px-3 py-2 text-xs capitalize text-slate-200 shadow-lg backdrop-blur-md md:bottom-7 md:right-7"
      >
        <span className="text-sm" aria-hidden="true">{emotionIcon[emotion]}</span>
        <span>{emotion}</span>
      </div>
    </div>
  );
}

useGLTF.preload("/models/avatar.glb");
