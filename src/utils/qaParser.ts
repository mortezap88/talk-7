export interface ParsedQaSuggestion {
  question: string;
  answer: string;
  marker?: string;
}

export type ParsedAssistantSegment =
  | { type: 'markdown'; content: string }
  | { type: 'qa'; suggestion: ParsedQaSuggestion };

export type ChatIntent =
  | { type: 'add_last_question' }
  | { type: 'delete_question'; index: number }
  | { type: 'change_question'; index: number; newQuestion: string };

export interface MessageSegment {
  type: 'text' | 'code';
  content: string;
  language?: string;
}

const PERSIAN_DIGITS: Record<string, string> = {
  '۰': '0',
  '۱': '1',
  '۲': '2',
  '۳': '3',
  '۴': '4',
  '۵': '5',
  '۶': '6',
  '۷': '7',
  '۸': '8',
  '۹': '9',
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9',
};

export function normalizeDigits(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (ch) => PERSIAN_DIGITS[ch] ?? ch);
}

/**
 * Splits an assistant message into ordered markdown and Q&A segments so each
 * Q&A pair can be rendered once in-place (with its save checkbox) without
 * duplicating the question below the message or swallowing trailing prose.
 */
export function splitAssistantMessageByQa(text: string): ParsedAssistantSegment[] {
  if (!text || !text.trim()) return [];

  const lines = text.split(/\r?\n/);
  const segments: ParsedAssistantSegment[] = [];

  const questionHeaderRe =
    /^\s*(?:\*{0,2})?(?:[Qq](?:uestion)?\s*)?([0-9۰-۹٠-٩]+)[.)\]:\-]\s*(.+?)\s*$/;
  const answerPrefixRe =
    /^\s*(?:[-*•]\s*)?(?:\*{0,2})?(?:Answer|Ans|پاسخ|جواب)\s*[:：]\s*(?:\*{0,2})?(.*)$/i;
  const listOrIndentedRe = /^\s*(?:[-*•]\s+|\$\$|\\\[)|^\s{2,}\S/;

  let pendingMarkdownLines: string[] = [];
  let qaRawLines: string[] = [];
  let currentMarker: string | undefined;
  let currentQuestion: string | null = null;
  let currentAnswerLines: string[] = [];
  let collectingAnswer = false;
  let sawBlankInAnswer = false;
  let inFence = false;

  const pushMarkdown = (rawLines: string[]) => {
    if (rawLines.length === 0) return;
    const content = rawLines.join('\n');
    const prev = segments[segments.length - 1];
    if (prev && prev.type === 'markdown') {
      prev.content = `${prev.content}\n${content}`;
    } else {
      segments.push({ type: 'markdown', content });
    }
  };

  const resetQaState = () => {
    qaRawLines = [];
    currentMarker = undefined;
    currentQuestion = null;
    currentAnswerLines = [];
    collectingAnswer = false;
    sawBlankInAnswer = false;
  };

  const flushQa = () => {
    if (currentQuestion && collectingAnswer) {
      const answer = currentAnswerLines.join('\n').trim();
      let question = currentQuestion.trim();
      if (question.startsWith('**') && question.endsWith('**') && question.length > 4) {
        question = question.slice(2, -2).trim();
      }
      if (question && answer) {
        if (pendingMarkdownLines.some((l) => l.trim().length > 0)) {
          pushMarkdown(pendingMarkdownLines);
        }
        pendingMarkdownLines = [];
        segments.push({
          type: 'qa',
          suggestion: {
            question,
            answer,
            ...(currentMarker ? { marker: currentMarker } : {}),
          },
        });
        resetQaState();
        return;
      }
    }

    // Not a valid Q&A pair — preserve the raw lines as regular markdown
    if (qaRawLines.length > 0) {
      pendingMarkdownLines.push(...qaRawLines);
    }
    resetQaState();
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      if (currentQuestion !== null) {
        flushQa();
      }
      inFence = !inFence;
      pendingMarkdownLines.push(line);
      continue;
    }

    if (inFence) {
      pendingMarkdownLines.push(line);
      continue;
    }

    const answerMatch = line.match(answerPrefixRe);
    if (answerMatch && currentQuestion !== null && !collectingAnswer) {
      collectingAnswer = true;
      sawBlankInAnswer = false;
      qaRawLines.push(line);
      if (answerMatch[1]?.trim()) {
        currentAnswerLines.push(answerMatch[1].trim());
      }
      continue;
    }

    const headerMatch = line.match(questionHeaderRe);
    if (headerMatch) {
      const marker = headerMatch[1];
      const body = headerMatch[2];
      const inlineSplit = body.match(/^(.*?)\s+(?:Answer|Ans|پاسخ|جواب)\s*[:：]\s*(.+)$/i);
      if (currentQuestion !== null) {
        flushQa();
      }
      qaRawLines = [line];
      currentMarker = marker;
      sawBlankInAnswer = false;
      if (inlineSplit) {
        currentQuestion = inlineSplit[1].trim();
        collectingAnswer = true;
        currentAnswerLines = [inlineSplit[2].trim()];
      } else {
        currentQuestion = body.trim();
        collectingAnswer = false;
        currentAnswerLines = [];
      }
      continue;
    }

    if (currentQuestion !== null) {
      if (collectingAnswer) {
        // Explicit structural breaks end the Q&A answer cleanly
        if (/^\s*(?:---+|===+|#{1,6}\s+|>\s?)/.test(line)) {
          flushQa();
          pendingMarkdownLines.push(line);
          continue;
        }

        if (!trimmed) {
          sawBlankInAnswer = true;
          qaRawLines.push(line);
          currentAnswerLines.push(line);
          continue;
        }

        const hasAnswerContent = currentAnswerLines.some((l) => l.trim().length > 0);
        const lastNonEmptyAnswerLine = [...currentAnswerLines]
          .reverse()
          .find((l) => l.trim().length > 0);
        const prevEndedCloze = Boolean(
          lastNonEmptyAnswerLine && /%%$/.test(lastNonEmptyAnswerLine.trim())
        );

        // If the answer already closed a self-contained cloze block (e.g. "پاسخ: %%...%%")
        // or was followed by a blank line and then regular prose (not a list/math continuation),
        // treat the new line as trailing message prose rather than part of the answer.
        if (hasAnswerContent) {
          if (prevEndedCloze && !/^\s*(?:[-*•]\s+|%%)/.test(line)) {
            flushQa();
            pendingMarkdownLines.push(line);
            continue;
          }
          if (sawBlankInAnswer && !listOrIndentedRe.test(line)) {
            flushQa();
            pendingMarkdownLines.push(line);
            continue;
          }
        }

        sawBlankInAnswer = false;
        qaRawLines.push(line);
        currentAnswerLines.push(line);
        continue;
      }

      if (trimmed) {
        // Only treat non-structural lines as multi-line question continuation before Answer:
        if (/^\s*(?:---+|===+|#{1,6}\s+|>\s?)/.test(line)) {
          flushQa();
          pendingMarkdownLines.push(line);
        } else {
          qaRawLines.push(line);
          currentQuestion = `${currentQuestion} ${trimmed}`.trim();
        }
        continue;
      }

      // Blank line before seeing any Answer: means this wasn't a tight Q&A header block
      flushQa();
      pendingMarkdownLines.push(line);
      continue;
    }

    pendingMarkdownLines.push(line);
  }

  if (currentQuestion !== null) {
    flushQa();
  }
  if (pendingMarkdownLines.some((l) => l.trim().length > 0)) {
    pushMarkdown(pendingMarkdownLines);
  }

  return segments
    .map((seg) =>
      seg.type === 'markdown' ? { ...seg, content: seg.content.trim() } : seg
    )
    .filter((seg) => seg.type === 'qa' || seg.content.length > 0);
}

/**
 * Parses numbered questions with `Answer:` (English) or `پاسخ:` / `جواب:` (Persian) lines
 * from an assistant message.
 */
export function parseQaSuggestions(text: string): ParsedQaSuggestion[] {
  return splitAssistantMessageByQa(text)
    .filter((seg): seg is { type: 'qa'; suggestion: ParsedQaSuggestion } => seg.type === 'qa')
    .map((seg) => seg.suggestion);
}

/**
 * Parses direct chat intents that edit the Questions list locally without an AI call.
 */
export function parseChatIntent(rawInput: string): ChatIntent | null {
  const input = normalizeDigits(rawInput).trim();
  if (!input) return null;

  if (/^(?:please\s+)?(?:add|save)\s+this\s+question[.!?]*$/i.test(input)) {
    return { type: 'add_last_question' };
  }

  const delMatch = input.match(
    /^(?:please\s+)?(?:delete|remove)\s+question\s+#?(\d+)[.!?]*$/i
  );
  if (delMatch) {
    const index = Number.parseInt(delMatch[1], 10);
    if (Number.isFinite(index) && index >= 1) {
      return { type: 'delete_question', index };
    }
  }

  const changeMatch = input.match(
    /^(?:please\s+)?(?:change|update|edit)\s+question\s+#?(\d+)\s+to\s+(.+)$/is
  );
  if (changeMatch) {
    const index = Number.parseInt(changeMatch[1], 10);
    const newQuestion = changeMatch[2].trim();
    if (Number.isFinite(index) && index >= 1 && newQuestion) {
      return { type: 'change_question', index, newQuestion };
    }
  }

  return null;
}

/**
 * Splits a message into plain text and fenced code blocks for safe React rendering.
 */
export function parseMessageSegments(content: string): MessageSegment[] {
  if (!content) return [];
  const segments: MessageSegment[] = [];
  const fenceRe = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: 'text',
        content: content.slice(lastIndex, match.index),
      });
    }
    segments.push({
      type: 'code',
      language: match[1]?.trim() || undefined,
      content: match[2].replace(/\n$/, ''),
    });
    lastIndex = fenceRe.lastIndex;
  }

  if (lastIndex < content.length) {
    segments.push({
      type: 'text',
      content: content.slice(lastIndex),
    });
  }

  return segments;
}
