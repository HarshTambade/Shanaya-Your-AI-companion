import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Html, OrbitControls, useAnimations, useGLTF, useProgress } from "@react-three/drei";
import { Box3, Group, MathUtils, Mesh, Vector3 } from "three";
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
  const emotionPulse = useRef(0);
  const { actions } = useAnimations(animations, group);

  useEffect(() => {
    applyEmotionMorph(scene, emotion);
    emotionPulse.current = 0;
  }, [emotion, scene]);

  const framing = useMemo(() => {
    const bounds = new Box3().setFromObject(scene);
    const size = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());
    const scale = size.y > 0 ? 3.15 / size.y : 1;
    return {
      scale,
      sourceHeight: size.y,
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

  useFrame(({ clock }, delta) => {
    if (!group.current) return;

    // The GLB has no embedded animation or morph targets, so give it a gentle idle
    // and emotion-specific body language. Keep the floor correction on the inner
    // model group; applying it here as well was lifting the avatar out of frame.
    emotionPulse.current += delta;
    const pulse = Math.exp(-emotionPulse.current * 3.2);
    const pose = emotionPose[emotion];
    const time = clock.elapsedTime;
    const avatar = group.current;

    avatar.position.y = Math.sin(time * 1.55) * 0.018 + pose.bounce * pulse;
    avatar.rotation.x = MathUtils.damp(avatar.rotation.x, pose.lean + Math.sin(time * 0.45) * 0.012, 3.5, delta);
    avatar.rotation.y = MathUtils.damp(avatar.rotation.y, pose.turn + Math.sin(time * 0.3) * 0.035, 2.8, delta);
    avatar.rotation.z = MathUtils.damp(avatar.rotation.z, pose.tilt + Math.sin(time * 0.65) * 0.012, 3.5, delta);
    const scale = 1 + (emotion === "surprised" ? 0.035 : 0.012) * pulse;
    avatar.scale.setScalar(MathUtils.damp(avatar.scale.x, scale, 4, delta));
  });

  return (
    <group ref={group}>
      <group position={framing.position} scale={framing.scale}>
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
      <Canvas camera={{ position: [0, 1.4, 5.4], fov: 35 }} dpr={[1, 1.75]} gl={{ alpha: true, antialias: true }}>
        <ambientLight intensity={1.8} />
        <directionalLight position={[3, 5, 4]} intensity={3.1} color="#fff2df" />
        <directionalLight position={[-4, 2, -3]} intensity={2.2} color="#a6a5ff" />
        <pointLight position={[0, 1.8, 2.5]} intensity={0.95} color={emotionLight[emotion]} />
        <Suspense fallback={<SceneLoader />}>
          <Avatar emotion={emotion} />
          <Environment preset="studio" />
        </Suspense>
        <OrbitControls
          target={[0, 1.58, 0]}
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

useGLTF.preload("/models/avatar.glb");
