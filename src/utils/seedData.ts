import type {
  AppSettings,
  ChatItem,
  ChatMemory,
  FlashcardItem,
  GeminiModel,
  NoteData,
  StoredQuestion,
  TextbookData,
} from '../types/talk';

export const VALID_GEMINI_MODELS: GeminiModel[] = [
  'gemini-4-hydrogen',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
];

export interface PersistedWorkspace {
  version: 1;
  chats: ChatItem[];
  kv: Record<string, unknown>;
  cards: FlashcardItem[];
  subjects: string[];
  settings: {
    provider: AppSettings['provider'];
    geminiModel: GeminiModel;
    thinkingLevel: AppSettings['thinkingLevel'];
    themeMode: AppSettings['themeMode'];
  };
}

const SAMPLE_BOHR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 380" width="640" height="380">
  <rect width="640" height="380" fill="#f8fafc"/>
  <rect x="24" y="24" width="592" height="332" rx="8" fill="#ffffff" stroke="#e2e8f0" stroke-width="1.5"/>
  <text x="48" y="58" font-family="sans-serif" font-size="16" font-weight="700" fill="#0f172a">Hemoglobin Oxygen-Dissociation Curve (Bohr Shift)</text>
  <line x1="90" y1="305" x2="575" y2="305" stroke="#64748b" stroke-width="1.5"/>
  <line x1="90" y1="90" x2="90" y2="305" stroke="#64748b" stroke-width="1.5"/>
  <path d="M90,305 C145,295 170,175 240,130 C320,98 430,96 560,94" fill="none" stroke="#0284c7" stroke-width="3"/>
  <path d="M90,305 C175,300 225,215 305,155 C385,112 465,102 560,98" fill="none" stroke="#dc2626" stroke-width="3" stroke-dasharray="7 5"/>
  <text x="248" y="114" font-family="sans-serif" font-size="13" font-weight="600" fill="#0284c7">pH 7.4 (Resting)</text>
  <text x="348" y="168" font-family="sans-serif" font-size="13" font-weight="600" fill="#dc2626">pH 7.2 (Active tissue, high CO2)</text>
  <text x="310" y="336" font-family="sans-serif" font-size="12" fill="#475569">Partial Pressure of O2 (mmHg)</text>
  <text x="38" y="210" font-family="sans-serif" font-size="12" fill="#475569" transform="rotate(-90 38 210)">Hb Saturation (%)</text>
</svg>`;

function encodeSvgDataUrl(svg: string): string {
  if (typeof btoa === 'function') {
    const bytes = new TextEncoder().encode(svg);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return `data:image/svg+xml;base64,${btoa(binary)}`;
  }
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function createSeedWorkspace(now = Date.now()): PersistedWorkspace {
  const chat1Id = 'chat_bio_bohr';
  const chat2Id = 'chat_chem_stereo';

  const chat1Memory: ChatMemory = {
    version: 2,
    compactedCount: 1,
    compactedTokens: 980,
    epoch: 1,
    learnerState: [
      {
        id: 'cs_seed_salt_bridge',
        concept: 'His146(beta)–Asp94 Salt Bridge',
        status: 'shaky',
        note: 'Need to connect His146 protonation at lower pH to T-state dimer stabilization.',
        updatedAt: now - 1000 * 60 * 20,
      },
      {
        id: 'cs_seed_bohr_shift',
        concept: 'Bohr Curve Right-Shift Direction',
        status: 'understood',
        note: 'Improved: resolved confusion between left/right O2 affinity shifts under exercise.',
        updatedAt: now - 1000 * 60 * 15,
      },
    ],
    packs: [
      {
        id: 'pack_s1_1',
        stage: 1,
        summary:
          '**Discussed & Subtopics Covered:** Myoglobin vs. hemoglobin quaternary structure, P50 comparison (~2.8 vs. ~26 mmHg), and Hill coefficient intuition.\n**Conclusions:** Monomeric myoglobin shows hyperbolic O2 binding; tetrameric HbA shows sigmoidal cooperative binding.\n**Blindspots:** Role of alpha-beta salt-bridge cleavage in T-to-R transitions needs follow-up.',
        bullets: [
          'Distinguished monomeric myoglobin (hyperbolic) from tetrameric hemoglobin (sigmoidal).',
          'Confirmed P50 for myoglobin is ~2.8 mmHg vs. ~26 mmHg for HbA.',
          'Blindspot: salt-bridge cleavage between alpha-beta dimers flagged to revisit.',
        ],
        tokenCount: 145,
        sourceRange: [0, 2],
        createdAt: now - 1000 * 60 * 50,
      },
      {
        id: 'pack_s1_2',
        stage: 1,
        summary:
          '**Discussed & Subtopics Covered:** CO2 hydration via carbonic anhydrase and His146 protonation on beta subunits.\n**Conclusions:** Derived $\\text{H}_2\\text{O} + \\text{CO}_2 \\rightleftharpoons \\text{H}^+ + \\text{HCO}_3^-$ and linked His146(beta) protonation to Asp94 T-state stabilization.\n**Understanding Improvements:** Clarified why lower pH shifts the dissociation curve rightward to release O2 in active muscle.',
        bullets: [
          'Derived H2O + CO2 ⇌ H2CO3 ⇌ H+ + HCO3- inside erythrocytes.',
          'Linked His146(beta) protonation to Asp94 salt-bridge stabilization in T-state.',
        ],
        tokenCount: 132,
        sourceRange: [2, 4],
        createdAt: now - 1000 * 60 * 25,
      },
      {
        id: 'pack_s2_1',
        stage: 2,
        summary:
          '**Discussed & Subtopics Covered:** Respiratory gas transport foundations, O2 binding equilibria, cooperative subunit transitions, and red-cell buffering.\n**Conclusions:** Core R-state vs. T-state equilibrium established across lung and muscle PO2.',
        bullets: [
          'Core R-state vs. T-state equilibrium established across lung and muscle PO2.',
          'Identified pH/PCO2 shift mechanics as primary exam focus.',
        ],
        tokenCount: 118,
        sourceRange: [2, 4],
        createdAt: now - 1000 * 60 * 90,
      },
    ],
    updatedAt: now - 1000 * 60 * 15,
  };

  const chat2Memory: ChatMemory = {
    version: 2,
    compactedCount: 0,
    compactedTokens: 0,
    epoch: 0,
    learnerState: [],
    packs: [],
    updatedAt: now - 1000 * 60 * 120,
  };

  const chat1Note: NoteData = {
    title: 'Chapter 42 — Oxygen Transport & Bohr Shift',
    body:
      'Focus on how metabolically active skeletal muscle increases PCO2 and lowers local pH from 7.4 to ~7.2.\n\nRemember: Right shift = Higher P50 = Lower O2 affinity = Greater O2 unloading to tissues.',
    tags: ['physiology', 'hemoglobin', 'midterm'],
    updatedAt: now - 1000 * 60 * 14,
  };

  const chat2Note: NoteData = {
    title: 'Stereochemistry Checklist',
    body: '1. Assign atomic number priorities at the chiral center.\n2. Put priority 4 in the back.\n3. Read 1 -> 2 -> 3 (CW = R, CCW = S).',
    tags: ['organic-chem', 'chiral'],
    updatedAt: now - 1000 * 60 * 110,
  };

  const q1Id = 'q_bohr_1';
  const fc1Id = 'fc_bohr_1';

  const chat1Questions: StoredQuestion[] = [
    {
      id: q1Id,
      question: 'How does a decrease in blood pH affect hemoglobin P50 and oxygen unloading?',
      answer:
        'A lower pH protonates key histidine residues (such as His146 on beta chains), stabilizing the T-state. This shifts the dissociation curve right, increases P50 (lower O2 affinity), and promotes oxygen unloading in active tissues.',
      flashcardId: fc1Id,
      createdAt: now - 1000 * 60 * 20,
      updatedAt: now - 1000 * 60 * 20,
    },
  ];

  const textbook: TextbookData = {
    title: '',
    body: '',
    images: [],
    updatedAt: 0,
  };

  const bohrDataUrl = encodeSvgDataUrl(SAMPLE_BOHR_SVG);

  const chats: ChatItem[] = [
    {
      id: chat1Id,
      title: 'Cellular Respiration & Bohr Effect',
      updatedAt: now - 1000 * 60 * 5,
      messages: [
        {
          id: 'm_legacy_1',
          role: 'assistant',
          content:
            'Prior session summary: Established P50 differences between fetal hemoglobin (HbF, ~19 mmHg) and adult hemoglobin (HbA, ~26 mmHg), plus myoglobin hyperbolic saturation.',
          createdAt: now - 1000 * 60 * 55,
          memoryStage: 1,
        },
        {
          id: 'm_1',
          role: 'user',
          content:
            'I attached the dissociation curve from my lecture slide. Why does lowering pH push the curve to the right instead of the left?',
          createdAt: now - 1000 * 60 * 12,
          attachments: [
            {
              id: 'att_bohr_fig',
              kind: 'image',
              name: 'bohr-dissociation-curve.svg',
              mimeType: 'image/svg+xml',
              dataUrl: bohrDataUrl,
            },
          ],
        },
        {
          id: 'm_2',
          role: 'assistant',
          content: `Great question — look at what "right shift" means on your graph: at the same PO2 (say 40 mmHg in muscle tissue), hemoglobin holds a lower percentage of oxygen, meaning it has released more O2 to the cells.

Here is the equilibrium inside the red blood cell:

\`\`\`chem
CO2 + H2O  <==>  H2CO3  <==>  H+ + HCO3-
Hb(O2)4 + H+  <==>  HbH+ + 4 O2
\`\`\`

Here are two quick self-check questions you can add to your deck:

1. Why does protonating His146 on the beta-globin chains favor oxygen release?
Answer: Protonated His146 forms an electrostatic salt bridge with Asp94 that locks hemoglobin in the low-affinity T-state, promoting O2 unloading.

2. At PO2 = 40 mmHg, does a right-shifted curve yield higher or lower hemoglobin O2 saturation than a normal pH 7.4 curve?
Answer: Lower saturation, because hemoglobin's affinity for O2 decreases when pH drops, freeing more oxygen for respiring muscle.`,
          createdAt: now - 1000 * 60 * 5,
        },
      ],
    },
    {
      id: chat2Id,
      title: 'Organic Chemistry — Stereochemistry',
      updatedAt: now - 1000 * 60 * 95,
      messages: [
        {
          id: 'm_chem_1',
          role: 'user',
          content: 'چطور اولویت گروه‌های دارای پیوند دوگانه را در قانون CIP مشخص کنیم؟',
          createdAt: now - 1000 * 60 * 100,
        },
        {
          id: 'm_chem_2',
          role: 'assistant',
          content: `در قانون کان-اینگولد-پرلوگ (CIP)، هر پیوند دوگانه به صورت پیوندهای یگانه با اتم‌های فرضی (phantom atoms) در نظر گرفته می‌شود.

۱. در گروه آلدهید (-CHO)، اتم کربن به چند اکسیژن متصل فرض می‌شود؟
پاسخ: کربن به دو اکسیژن (یکی واقعی و یکی فرضی به دلیل پیوند دوگانه C=O) و یک هیدروژن متصل در نظر گرفته می‌شود، بنابراین اولویت آن از الکل (-CH2OH) بیشتر است.`,
          createdAt: now - 1000 * 60 * 95,
        },
      ],
    },
  ];

  const cards: FlashcardItem[] = [
    {
      id: fc1Id,
      chatId: chat1Id,
      questionId: q1Id,
      question: chat1Questions[0].question,
      answer: chat1Questions[0].answer,
      type: 'EXAM',
      status: 'NEW',
      subject: 'Cellular Respiration & Bohr Effect',
      createdAt: now - 1000 * 60 * 20,
      updatedAt: now - 1000 * 60 * 20,
    },
  ];

  return {
    version: 1,
    chats,
    kv: {
      [`note:${chat1Id}`]: chat1Note,
      [`note:${chat2Id}`]: chat2Note,
      [`questions:${chat1Id}`]: chat1Questions,
      [`questions:${chat2Id}`]: [],
      [`memory:${chat1Id}`]: chat1Memory,
      [`memory:${chat2Id}`]: chat2Memory,
      [`textbook:${chat1Id}`]: textbook,
      [`textbook:${chat2Id}`]: textbook,
    },
    cards,
    subjects: ['Biology', 'Organic Chemistry', 'Biochemistry', 'General Study'],
    settings: {
      provider: 'gemini',
      geminiModel: 'gemini-4-hydrogen',
      thinkingLevel: 'medium',
      themeMode: 'system',
    },
  };
}
