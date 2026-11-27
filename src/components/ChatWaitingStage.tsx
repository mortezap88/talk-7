import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';

interface BotPalette {
  id: string;
  body: [number, number, number];
  shadow: [number, number, number];
  highlight: [number, number, number];
  dropShadowRgba: string;
}

const BOT_PALETTES: BotPalette[] = [
  // 1. Signature Periwinkle Purple
  {
    id: 'periwinkle',
    body: [0.49, 0.56, 0.98],
    shadow: [0.24, 0.29, 0.72],
    highlight: [0.81, 0.85, 1.0],
    dropShadowRgba: 'rgba(84, 98, 224, 0.28)',
  },
  // 2. Mint Matcha
  {
    id: 'mint',
    body: [0.3, 0.83, 0.64],
    shadow: [0.11, 0.48, 0.36],
    highlight: [0.74, 0.98, 0.89],
    dropShadowRgba: 'rgba(36, 179, 128, 0.26)',
  },
  // 3. Peach Coral
  {
    id: 'peach',
    body: [0.98, 0.55, 0.46],
    shadow: [0.68, 0.24, 0.19],
    highlight: [1.0, 0.84, 0.79],
    dropShadowRgba: 'rgba(232, 99, 77, 0.26)',
  },
  // 4. Cerulean Sky
  {
    id: 'sky',
    body: [0.33, 0.71, 0.99],
    shadow: [0.13, 0.38, 0.72],
    highlight: [0.78, 0.92, 1.0],
    dropShadowRgba: 'rgba(49, 149, 234, 0.26)',
  },
  // 5. Rose Blossom
  {
    id: 'rose',
    body: [0.96, 0.49, 0.69],
    shadow: [0.62, 0.18, 0.39],
    highlight: [1.0, 0.82, 0.9],
    dropShadowRgba: 'rgba(220, 86, 142, 0.26)',
  },
  // 6. Orchid Lilac
  {
    id: 'lilac',
    body: [0.69, 0.52, 0.99],
    shadow: [0.38, 0.21, 0.72],
    highlight: [0.89, 0.82, 1.0],
    dropShadowRgba: 'rgba(138, 92, 235, 0.26)',
  },
  // 7. Honey Butterscotch
  {
    id: 'honey',
    body: [0.99, 0.69, 0.3],
    shadow: [0.68, 0.36, 0.08],
    highlight: [1.0, 0.91, 0.74],
    dropShadowRgba: 'rgba(227, 134, 32, 0.26)',
  },
  // 8. Aqua Lagoon
  {
    id: 'aqua',
    body: [0.25, 0.8, 0.86],
    shadow: [0.09, 0.45, 0.54],
    highlight: [0.74, 0.96, 0.99],
    dropShadowRgba: 'rgba(32, 174, 191, 0.26)',
  },
  // 9. Berry Grape
  {
    id: 'berry',
    body: [0.57, 0.49, 0.98],
    shadow: [0.29, 0.22, 0.71],
    highlight: [0.84, 0.81, 1.0],
    dropShadowRgba: 'rgba(110, 86, 230, 0.28)',
  },
  // 10. Strawberry Cream
  {
    id: 'strawberry',
    body: [0.97, 0.5, 0.62],
    shadow: [0.64, 0.19, 0.32],
    highlight: [1.0, 0.83, 0.88],
    dropShadowRgba: 'rgba(219, 86, 120, 0.26)',
  },
];

const PALETTE_STORAGE_KEY = 'talk_chat_bot_palette_v1';

function fnv1aHash(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function resolveBotPaletteForChat(chatId: string): BotPalette {
  const key = chatId || 'default_chat';
  const baseIdx = fnv1aHash(key) % BOT_PALETTES.length;
  if (typeof window === 'undefined') {
    return BOT_PALETTES[baseIdx];
  }

  try {
    const raw = window.localStorage.getItem(PALETTE_STORAGE_KEY);
    const parsed: { map?: Record<string, number>; lastIdx?: number } = raw
      ? JSON.parse(raw)
      : {};
    const map = parsed.map && typeof parsed.map === 'object' ? { ...parsed.map } : {};
    if (typeof map[key] === 'number' && BOT_PALETTES[map[key]]) {
      return BOT_PALETTES[map[key]];
    }

    let chosenIdx = baseIdx;
    if (typeof parsed.lastIdx === 'number' && chosenIdx === parsed.lastIdx) {
      chosenIdx = (chosenIdx + 1) % BOT_PALETTES.length;
    }

    const entries = Object.entries(map);
    if (entries.length > 180) {
      for (const [oldKey] of entries.slice(0, entries.length - 180)) {
        delete map[oldKey];
      }
    }
    map[key] = chosenIdx;
    window.localStorage.setItem(
      PALETTE_STORAGE_KEY,
      JSON.stringify({ map, lastIdx: chosenIdx })
    );
    return BOT_PALETTES[chosenIdx];
  } catch {
    return BOT_PALETTES[baseIdx];
  }
}

/**
 * Measures the exact viewport (x, y) pixel center of the current caret inside a <textarea>,
 * along with the textarea's live bounding box so gaze normalizes accurately across narrow and wide panes.
 */
function measureTextareaCaretViewport(
  textarea: HTMLTextAreaElement
): { x: number; y: number; boxRect: DOMRect } | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }
  const rect = textarea.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const computed = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');
  const style = mirror.style;

  style.position = 'fixed';
  style.top = '-9999px';
  style.left = '-9999px';
  style.visibility = 'hidden';
  style.pointerEvents = 'none';
  style.whiteSpace = 'pre-wrap';
  style.overflow = 'hidden';

  const copiedProps = [
    'boxSizing',
    'width',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'letterSpacing',
    'lineHeight',
    'textAlign',
    'textTransform',
    'textIndent',
    'wordSpacing',
    'overflowWrap',
    'wordBreak',
    'tabSize',
  ] as const;

  for (const prop of copiedProps) {
    style[prop] = computed[prop];
  }
  style.wordWrap = computed.overflowWrap || 'break-word';

  mirror.dir = textarea.dir || 'auto';
  const caretOffset =
    typeof textarea.selectionEnd === 'number'
      ? textarea.selectionEnd
      : textarea.value.length;

  const textBeforeCaret = textarea.value.slice(0, caretOffset);
  const textAfterCaret = textarea.value.slice(caretOffset);

  mirror.textContent = textBeforeCaret;
  const marker = document.createElement('span');
  // Following standard textarea-caret-position: non-empty span ensures accurate line/offsetLeft even after newlines or line wraps
  marker.textContent = textAfterCaret || '.';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const markerLeft = marker.offsetLeft - textarea.scrollLeft;
  const markerTop = marker.offsetTop - textarea.scrollTop;
  const lineH = parseFloat(computed.lineHeight) || 20;

  document.body.removeChild(mirror);

  const clampedLocalX = Math.max(6, Math.min(rect.width - 6, markerLeft));
  const clampedLocalY = Math.max(6, Math.min(rect.height - 6, markerTop + lineH * 0.5));

  return {
    x: rect.left + clampedLocalX,
    y: rect.top + clampedLocalY,
    boxRect: rect,
  };
}

const VERTEX_SHADER_SRC = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  void main() {
    v_uv = a_pos;
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }
`;

// Unified single-piece 3D clay rounded cube + embedded sculpted pill eyes
const FRAGMENT_SHADER_SRC = `
  precision highp float;
  varying vec2 v_uv;

  uniform vec2 u_res;
  uniform vec3 u_rot;       // (pitchX, yawY, rollZ) in radians
  uniform vec3 u_offset;    // (translateX, translateY, squash)
  uniform vec2 u_eyeOffset; // (eyeX, eyeY) in local cube units
  uniform float u_blink;    // 1.0 = open, 0.12 = blinked
  uniform vec3 u_bodyColor;
  uniform vec3 u_shadowColor;
  uniform vec3 u_highlightColor;

  mat2 rot2(float a) {
    float c = cos(a);
    float s = sin(a);
    return mat2(c, -s, s, c);
  }

  float sdRoundBox(vec3 p, vec3 b, float r) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
  }

  vec3 toLocal(vec3 p) {
    vec3 q = p - vec3(u_offset.x, u_offset.y, 0.0);
    float sy = 1.0 + u_offset.z;
    float sxz = 1.0 / sqrt(max(0.55, sy));
    q.x /= sxz;
    q.z /= sxz;
    q.y /= sy;

    q.xy = rot2(-u_rot.z) * q.xy;
    q.yz = rot2(-u_rot.x) * q.yz;
    q.xz = rot2(-u_rot.y) * q.xz;
    return q;
  }

  float sdBody(vec3 q) {
    return sdRoundBox(q, vec3(0.45, 0.27, 0.35), 0.25);
  }

  float sdEyes(vec3 q) {
    float halfH = 0.088 * u_blink;
    vec3 eyeSize = vec3(0.028, halfH, 0.018);
    float eyeRad = 0.044;

    // Gentle curve wrap when eyes sweep wide left/right so they hug the rounded cube face naturally
    float lx = -0.195 + u_eyeOffset.x;
    float rx =  0.195 + u_eyeOffset.x;
    float zPullL = max(0.0, abs(lx) - 0.34) * 0.22;
    float zPullR = max(0.0, abs(rx) - 0.34) * 0.22;

    vec3 pL = q - vec3(lx, u_eyeOffset.y, 0.568 - zPullL);
    vec3 pR = q - vec3(rx, u_eyeOffset.y, 0.568 - zPullR);

    float dL = sdRoundBox(pL, eyeSize, eyeRad);
    float dR = sdRoundBox(pR, eyeSize, eyeRad);
    return min(dL, dR);
  }

  float mapScene(vec3 p) {
    vec3 q = toLocal(p);
    return min(sdBody(q), sdEyes(q));
  }

  vec3 calcNormal(vec3 p) {
    vec2 e = vec2(0.0022, 0.0);
    return normalize(vec3(
      mapScene(p + e.xyy) - mapScene(p - e.xyy),
      mapScene(p + e.yxy) - mapScene(p - e.yxy),
      mapScene(p + e.yyx) - mapScene(p - e.yyx)
    ));
  }

  void main() {
    float aspect = u_res.x / max(1.0, u_res.y);
    vec2 uv = vec2(v_uv.x * aspect, v_uv.y);

    vec3 ro = vec3(0.0, 0.02, 2.75);
    vec3 rd = normalize(vec3(uv, -2.15));

    float t = 0.0;
    float minDist = 10.0;
    bool hit = false;

    for (int i = 0; i < 40; i++) {
      vec3 p = ro + rd * t;
      float d = mapScene(p);
      minDist = min(minDist, d);
      if (d < 0.0014) {
        hit = true;
        break;
      }
      t += d * 0.92;
      if (t > 5.0) break;
    }

    float alpha = hit ? 1.0 : smoothstep(0.013, 0.0, minDist);
    if (alpha <= 0.002) {
      gl_FragColor = vec4(0.0);
      return;
    }

    vec3 p = ro + rd * t;
    vec3 q = toLocal(p);
    vec3 n = calcNormal(p);
    vec3 v = -rd;

    float dB = sdBody(q);
    float dE = sdEyes(q);
    float eyeMask = smoothstep(0.011, -0.005, dE - dB);

    // 3-point soft studio clay lighting
    vec3 keyDir = normalize(vec3(-0.48, 0.76, 0.68));
    vec3 fillDir = normalize(vec3(0.55, -0.62, 0.42));
    vec3 specDir = normalize(vec3(-0.32, 0.65, 0.85));

    float wrapKey = pow(clamp(dot(n, keyDir) * 0.5 + 0.5, 0.0, 1.0), 1.45);
    float bottomBounce = clamp(dot(n, fillDir) * 0.5 + 0.5, 0.0, 1.0);

    float fresnel = pow(clamp(1.0 - max(dot(n, v), 0.0), 0.0, 1.0), 3.1);
    float topMask = smoothstep(-0.35, 0.75, n.y);

    vec3 halfVec = normalize(specDir + v);
    float spec = pow(max(dot(n, halfVec), 0.0), 20.0) * 0.22;

    vec3 bodyShade = mix(u_shadowColor, u_bodyColor, smoothstep(0.08, 0.68, wrapKey));
    bodyShade = mix(bodyShade, u_highlightColor, smoothstep(0.68, 1.0, wrapKey) * 0.46);
    bodyShade += u_highlightColor * bottomBounce * 0.08;
    bodyShade += mix(u_bodyColor, vec3(1.0), 0.65) * fresnel * (0.14 + 0.24 * topMask);
    bodyShade += vec3(1.0) * spec;

    float eyeAo = mix(0.76, 1.0, smoothstep(0.0, 0.072, max(0.0, dE)));
    bodyShade *= eyeAo;

    vec3 eyeShade = vec3(0.99, 0.995, 1.0) * (0.87 + 0.13 * wrapKey) + vec3(0.08) * spec;

    vec3 finalRgb = mix(bodyShade, eyeShade, eyeMask);
    finalRgb = clamp(finalRgb, 0.0, 1.0);

    gl_FragColor = vec4(finalRgb * alpha, alpha);
  }
`;

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

interface ChatWaitingHeroProps {
  chatId: string;
  inputValue: string;
  isComposerFocused: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onFocusComposer: () => void;
}

export function ChatWaitingHero({
  chatId,
  inputValue,
  isComposerFocused,
  textareaRef,
  onFocusComposer,
}: ChatWaitingHeroProps) {
  const botRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [webglFallback, setWebglFallback] = useState(false);

  const palette = useMemo(() => resolveBotPaletteForChat(chatId), [chatId]);

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // Live animation state refs driven at 60fps directly in WebGL
  const focusedRef = useRef(isComposerFocused);
  focusedRef.current = isComposerFocused;
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  const reducedMotionRef = useRef(prefersReducedMotion);
  reducedMotionRef.current = prefersReducedMotion;

  const targetPointerRef = useRef({ x: 0, y: 0 });
  const caretWorldRef = useRef<{
    x: number;
    y: number;
    boxHalfW: number;
  } | null>(null);
  const blinkScaleRef = useRef(1);
  const shakeImpulseRef = useRef(0);

  const refreshCaretTarget = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const measured = measureTextareaCaretViewport(textarea);
    if (!measured) return;
    caretWorldRef.current = {
      x: measured.x,
      y: measured.y,
      boxHalfW: Math.max(95, measured.boxRect.width * 0.45),
    };
  }, [textareaRef]);

  // Global pointer tracking ONLY used when idle (not typing/activated)
  useEffect(() => {
    const handlePointerMove = (e: globalThis.PointerEvent) => {
      const botEl = botRef.current;
      if (!botEl) return;
      const rect = botEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const nx = Math.max(-1, Math.min(1, (e.clientX - cx) / 380));
      const ny = Math.max(-1, Math.min(1, (e.clientY - cy) / 280));
      targetPointerRef.current = { x: nx, y: ny };
    };

    const handlePointerReset = () => {
      targetPointerRef.current = { x: 0, y: 0 };
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    document.addEventListener('mouseleave', handlePointerReset);
    window.addEventListener('blur', handlePointerReset);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('mouseleave', handlePointerReset);
      window.removeEventListener('blur', handlePointerReset);
    };
  }, []);

  // Measure caret whenever textbox focus, value, cursor navigation, or resize changes
  useEffect(() => {
    if (!isComposerFocused) {
      caretWorldRef.current = null;
      return;
    }

    const rafId = window.requestAnimationFrame(() => {
      refreshCaretTarget();
    });

    const textarea = textareaRef.current;
    if (!textarea) {
      return () => window.cancelAnimationFrame(rafId);
    }

    const syncCaret = () => {
      window.requestAnimationFrame(refreshCaretTarget);
    };
    textarea.addEventListener('keyup', syncCaret);
    textarea.addEventListener('mouseup', syncCaret);
    textarea.addEventListener('select', syncCaret);
    textarea.addEventListener('scroll', syncCaret);
    window.addEventListener('resize', syncCaret);

    return () => {
      window.cancelAnimationFrame(rafId);
      textarea.removeEventListener('keyup', syncCaret);
      textarea.removeEventListener('mouseup', syncCaret);
      textarea.removeEventListener('select', syncCaret);
      textarea.removeEventListener('scroll', syncCaret);
      window.removeEventListener('resize', syncCaret);
    };
  }, [isComposerFocused, inputValue, chatId, textareaRef, refreshCaretTarget]);

  // Natural occasional blinking
  useEffect(() => {
    if (prefersReducedMotion) return;
    let blinkTimeout = 0;
    let openTimeout = 0;
    let doubleTimeout = 0;
    let cancelled = false;

    const scheduleBlink = () => {
      const waitMs = 2400 + Math.random() * 2800;
      blinkTimeout = window.setTimeout(() => {
        if (cancelled) return;
        blinkScaleRef.current = 0.12;
        openTimeout = window.setTimeout(() => {
          if (cancelled) return;
          blinkScaleRef.current = 1;
          if (Math.random() < 0.22) {
            doubleTimeout = window.setTimeout(() => {
              if (cancelled) return;
              blinkScaleRef.current = 0.12;
              openTimeout = window.setTimeout(() => {
                if (!cancelled) blinkScaleRef.current = 1;
                scheduleBlink();
              }, 115);
            }, 130);
          } else {
            scheduleBlink();
          }
        }, 135);
      }, waitMs);
    };

    scheduleBlink();
    return () => {
      cancelled = true;
      window.clearTimeout(blinkTimeout);
      window.clearTimeout(openTimeout);
      window.clearTimeout(doubleTimeout);
    };
  }, [prefersReducedMotion]);

  // WebGL real-time unified 3D cube render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
    });
    if (!gl) {
      setWebglFallback(true);
      return;
    }

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
    if (!vs || !fs) {
      setWebglFallback(true);
      return;
    }

    const program = gl.createProgram();
    if (!program) {
      setWebglFallback(true);
      return;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      setWebglFallback(true);
      return;
    }

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    const aPos = gl.getAttribLocation(program, 'a_pos');
    const uRes = gl.getUniformLocation(program, 'u_res');
    const uRot = gl.getUniformLocation(program, 'u_rot');
    const uOffset = gl.getUniformLocation(program, 'u_offset');
    const uEyeOffset = gl.getUniformLocation(program, 'u_eyeOffset');
    const uBlink = gl.getUniformLocation(program, 'u_blink');
    const uBodyColor = gl.getUniformLocation(program, 'u_bodyColor');
    const uShadowColor = gl.getUniformLocation(program, 'u_shadowColor');
    const uHighlightColor = gl.getUniformLocation(program, 'u_highlightColor');

    const syncCanvasSize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const cssW = 136;
      const cssH = 114;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    syncCanvasSize();
    window.addEventListener('resize', syncCanvasSize);

    let rotX = -0.18;
    let rotY = 0;
    let rotZ = 0;
    let posY = 0;
    let eyeX = 0;
    let eyeY = 0;
    let blinkCur = 1;
    let squash = 0;
    let shakePhase = 0;
    let lastNow = performance.now();
    let rafId = 0;

    const tick = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.004, (now - lastNow) / 1000));
      lastNow = now;
      const tSec = now / 1000;

      const isFocused = focusedRef.current;
      const reduced = reducedMotionRef.current;

      // Balanced 3D overhead pitch (-0.19 rad) shows 3D top depth symmetrically without biasing left/right!
      const basePitch = -0.19;

      let targetPitch = basePitch;
      let targetYaw = 0;
      let targetRoll = 0;
      let targetY = 0;

      if (!isFocused && !reduced) {
        // Gentle floating bob + organic angle rocking as it goes up & down
        const bobWave = Math.sin(tSec * 1.6);
        const swayWave = Math.sin(tSec * 0.95);
        targetY = bobWave * 0.055;
        targetPitch += bobWave * 0.065;
        targetYaw += swayWave * 0.11;
        targetRoll += swayWave * 0.035;

        // Subtle interactive mouse-follow across the whole body (head) ONLY while idle
        const ptr = targetPointerRef.current;
        targetYaw += ptr.x * 0.24;
        targetPitch += -ptr.y * 0.17;
      }

      // Cute springy 3D shake impulse when clicked
      if (shakeImpulseRef.current > 0.001) {
        shakePhase += dt * 26;
        const amp = shakeImpulseRef.current;
        targetRoll += Math.sin(shakePhase) * 0.28 * amp;
        targetYaw += Math.cos(shakePhase * 0.75) * 0.24 * amp;
        squash += (Math.sin(shakePhase * 1.2) * 0.12 * amp - squash) * 0.38;
        targetY += Math.abs(Math.sin(shakePhase * 0.5)) * 0.05 * amp;
        shakeImpulseRef.current *= Math.pow(0.035, dt);
      } else {
        shakeImpulseRef.current = 0;
        squash += (0 - squash) * Math.min(1, dt * 12);
      }

      const smooth = Math.min(1, dt * 8.5);
      rotX += (targetPitch - rotX) * smooth;
      rotY += (targetYaw - rotY) * smooth;
      rotZ += (targetRoll - rotZ) * smooth;
      posY += (targetY - posY) * smooth;

      // Compute exact eye gaze dynamically against live bot position (stays accurate as bot glides to center!)
      let desiredEyeX = 0;
      let desiredEyeY = 0;

      if (isFocused && caretWorldRef.current && botRef.current) {
        const botRect = botRef.current.getBoundingClientRect();
        if (botRect.width > 0 && botRect.height > 0) {
          const botCx = botRect.left + botRect.width / 2;
          const botCy = botRect.top + botRect.height / 2;
          const caret = caretWorldRef.current;
          const dx = caret.x - botCx;
          const dy = caret.y - botCy;

          const normX = Math.max(-1, Math.min(1, dx / caret.boxHalfW));
          const normY = Math.max(-0.35, Math.min(1, dy / 130));

          const maxRx = 0.22;
          const maxRy = 0.125;
          const rawX = normX * maxRx;
          const rawY = -normY * maxRy; // WebGL +Y is up
          const radial = Math.hypot(rawX / maxRx, rawY / maxRy);
          if (radial > 1) {
            desiredEyeX = rawX / radial;
            desiredEyeY = rawY / radial;
          } else {
            desiredEyeX = rawX;
            desiredEyeY = rawY;
          }
        }
      } else if (!isFocused && !reduced) {
        // When idle & turning slightly toward pointer, counter-steer slightly so gaze stays right on you
        const ptr = targetPointerRef.current;
        desiredEyeX = -ptr.x * 0.03;
        desiredEyeY = ptr.y * 0.022;
      }

      const eyeSmooth = Math.min(1, dt * 14);
      eyeX += (desiredEyeX - eyeX) * eyeSmooth;
      eyeY += (desiredEyeY - eyeY) * eyeSmooth;
      blinkCur += (blinkScaleRef.current - blinkCur) * Math.min(1, dt * 28);

      const pal = paletteRef.current;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);

      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform3f(uRot, rotX, rotY, rotZ);
      gl.uniform3f(uOffset, 0, posY, squash);
      gl.uniform2f(uEyeOffset, eyeX, eyeY);
      gl.uniform1f(uBlink, blinkCur);
      gl.uniform3f(uBodyColor, pal.body[0], pal.body[1], pal.body[2]);
      gl.uniform3f(uShadowColor, pal.shadow[0], pal.shadow[1], pal.shadow[2]);
      gl.uniform3f(uHighlightColor, pal.highlight[0], pal.highlight[1], pal.highlight[2]);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', syncCanvasSize);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buffer);
    };
  }, []);

  const handleBotClick = () => {
    if (!prefersReducedMotion) {
      shakeImpulseRef.current = 1.0;
    }
    blinkScaleRef.current = 0.12;
    window.setTimeout(() => {
      blinkScaleRef.current = 1;
    }, 150);
  };

  const showSpeechBubble = !isComposerFocused;

  return (
    <div className="relative z-10 w-full flex items-center justify-center px-2 select-none">
      <div className="relative inline-flex items-center justify-center max-w-full">
        {/* Bot glides slowly & smoothly from left side to exact middle when textbox is activated */}
        <motion.div
          layout
          transition={
            prefersReducedMotion
              ? { duration: 0 }
              : {
                  layout: {
                    type: 'spring',
                    stiffness: 95,
                    damping: 20,
                    mass: 1.05,
                  },
                }
          }
          className="relative flex flex-col items-center shrink-0"
        >
          <button
            ref={botRef}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleBotClick();
            }}
            aria-label="Cute 3D study cube buddy"
            style={{
              filter: `drop-shadow(0 12px 16px ${palette.dropShadowRgba})`,
            }}
            className="group relative block cursor-pointer rounded-[28px] transition-transform duration-150 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-600"
          >
            {webglFallback ? (
              <div
                style={{
                  background: `radial-gradient(circle at 38% 24%, rgb(${palette.highlight.map((c) => Math.round(c * 255)).join(',')}), rgb(${palette.body.map((c) => Math.round(c * 255)).join(',')}) 65%, rgb(${palette.shadow.map((c) => Math.round(c * 255)).join(',')}))`,
                }}
                className="w-[108px] h-[78px] rounded-[26px] flex items-center justify-center gap-[20px]"
              >
                <span className="w-[12px] h-[19px] rounded-full bg-white" />
                <span className="w-[12px] h-[19px] rounded-full bg-white" />
              </div>
            ) : (
              <canvas
                ref={canvasRef}
                className="block w-[136px] h-[114px]"
              />
            )}
          </button>

          {/* Soft grounded shadow beneath the floating 3D cube */}
          <motion.div
            aria-hidden="true"
            animate={
              isComposerFocused || prefersReducedMotion
                ? { scaleX: 1, scaleY: 1, opacity: 0.2 }
                : {
                    scaleX: [1, 0.9, 1],
                    scaleY: [1, 0.88, 1],
                    opacity: [0.22, 0.14, 0.22],
                  }
            }
            transition={
              isComposerFocused || prefersReducedMotion
                ? { duration: 0.25 }
                : { duration: 3.9, repeat: Infinity, ease: 'easeInOut' }
            }
            className="-mt-2 h-[8px] w-[76px] rounded-full bg-slate-900/25 dark:bg-black/60 blur-[3.5px]"
          />
        </motion.div>

        {/* Speech bubble beside the bot saying "Send your first message" (only when textbox is inactive) */}
        <AnimatePresence mode="popLayout">
          {showSpeechBubble ? (
            <motion.button
              key="first-msg-bubble"
              type="button"
              layout
              initial={
                prefersReducedMotion
                  ? { opacity: 1 }
                  : { opacity: 0, scale: 0.86, x: -8 }
              }
              animate={
                prefersReducedMotion
                  ? { opacity: 1 }
                  : { opacity: 1, scale: 1, x: 0 }
              }
              exit={
                prefersReducedMotion
                  ? { opacity: 0 }
                  : { opacity: 0, scale: 0.86, x: -8 }
              }
              transition={{
                opacity: { duration: 0.22 },
                scale: { type: 'spring', stiffness: 320, damping: 26 },
                layout: { type: 'spring', stiffness: 95, damping: 20, mass: 1.05 },
              }}
              onClick={(e) => {
                e.stopPropagation();
                onFocusComposer();
              }}
              className="ml-2.5 sm:ml-3.5 -mt-2 relative inline-flex items-center px-3.5 py-2 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-700/80 shadow-[0_8px_22px_-8px_rgba(15,23,42,0.12)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] text-[13px] font-medium tracking-tight text-slate-700 dark:text-slate-200 hover:border-slate-300 dark:hover:border-slate-600 transition-colors cursor-pointer whitespace-nowrap focus-visible:outline-2 focus-visible:outline-sky-600"
            >
              {/* Speech bubble tail pointing left toward the 3D cube */}
              <span
                aria-hidden="true"
                className="absolute -left-[6px] top-1/2 -translate-y-1/2 w-2.5 h-2.5 rotate-45 rounded-[2px] bg-white dark:bg-slate-900 border-l border-b border-slate-200/90 dark:border-slate-700/80"
              />
              <span>Send your first message</span>
            </motion.button>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
