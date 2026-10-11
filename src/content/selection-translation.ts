import type {
  ContextualTranslationAdapter,
  DetailedTranslationResult
} from './background-translator.ts';
import type { TranslateFailureCode } from '../background/protocol.ts';
import type { TranslationPurpose } from '../core/translate/index.ts';
import type { DictionaryEntry } from './dictionary-store.ts';
import type { AudienceMode, CardColor, NativeLanguage, ThemeMode, UiLanguage } from '../shared/settings.ts';

function setStyles(element: HTMLElement, styles: Partial<CSSStyleDeclaration>): void {
  for (const [property, value] of Object.entries(styles)) {
    if (value !== undefined) {
      element.style.setProperty(
        property.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`),
        String(value)
      );
    }
  }
}

export interface DictionaryDefinition {
  partOfSpeech: string;
  meaning: string;
  englishMeaning?: string;
}

export interface DictionaryDisplayData {
  baseForm?: string;
  ukPronunciation?: string;
  usPronunciation?: string;
  pinyin?: string;
  difficulty?: string;
  examples?: string[];
  definitions: DictionaryDefinition[];
  networkMeaning?: string;
}

export interface SelectionLearningOptions {
  nativeLanguage?: NativeLanguage | null;
  audienceMode?: AudienceMode;
  uiLanguage?: UiLanguage;
  showOriginal?: boolean;
  showPinyin?: boolean;
  showDifficulty?: boolean;
  showExamples?: boolean;
}

export interface SelectionCardAppearance {
  theme: ThemeMode;
  cardColor: CardColor;
  fontScale: number;
}

export type SelectionPurpose = 'dictionary' | 'sentence';

export function clampFontScale(value: number): number {
  return Math.max(0.8, Math.min(1.25, Number.isFinite(value) ? value : 1));
}

export function nextThemeMode(theme: ThemeMode): ThemeMode {
  return theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
}

const CARD_COLOR_SURFACES: Record<CardColor, { light: string; dark: string; swatch: string }> = {
  neutral: { light: 'rgba(255, 255, 255, 0.96)', dark: 'rgba(28, 28, 30, 0.97)', swatch: '#f5f5f7' },
  blue: { light: 'rgba(239, 246, 255, 0.97)', dark: 'rgba(20, 38, 62, 0.97)', swatch: '#dbeafe' },
  green: { light: 'rgba(240, 253, 244, 0.97)', dark: 'rgba(19, 49, 35, 0.97)', swatch: '#dcfce7' },
  sand: { light: 'rgba(255, 251, 235, 0.97)', dark: 'rgba(62, 46, 20, 0.97)', swatch: '#fef3c7' },
  rose: { light: 'rgba(255, 241, 242, 0.97)', dark: 'rgba(63, 29, 38, 0.97)', swatch: '#ffe4e6' }
};

export function classifySelectionPurpose(text: string): SelectionPurpose {
  const normalized = text.trim();
  return /^[A-Za-z]+(?:[-'][A-Za-z]+)*$/u.test(normalized) || /^[\u3400-\u9fff]{1,8}$/u.test(normalized)
    ? 'dictionary'
    : 'sentence';
}

function isChineseSelection(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}

export function canTranslateSelection(
  text: string,
  _nativeLanguage: NativeLanguage | null | undefined
): boolean {
  return !isChineseSelection(text);
}

const PART_OF_SPEECH_LABELS = new Map<string, string>([
  ['n', 'n.'],
  ['noun', 'n.'],
  ['名词', 'n.'],
  ['v', 'v.'],
  ['verb', 'v.'],
  ['动词', 'v.'],
  ['adj', 'adj.'],
  ['adjective', 'adj.'],
  ['形容词', 'adj.'],
  ['adv', 'adv.'],
  ['adverb', 'adv.'],
  ['副词', 'adv.'],
  ['det', 'det.'],
  ['determiner', 'det.'],
  ['限定词', 'det.'],
  ['限定符', 'det.'],
  ['aux', 'aux.'],
  ['auxiliary', 'aux.'],
  ['auxiliary verb', 'aux.'],
  ['助动词', 'aux.'],
  ['modal verb', 'modal v.'],
  ['modal v', 'modal v.'],
  ['情态动词', 'modal v.'],
  ['num', 'num.'],
  ['number', 'num.'],
  ['numeral', 'num.'],
  ['数词', 'num.'],
  ['art', 'art.'],
  ['article', 'art.'],
  ['冠词', 'art.'],
  ['intj', 'int.'],
  ['prep', 'prep.'],
  ['preposition', 'prep.'],
  ['介词', 'prep.'],
  ['pron', 'pron.'],
  ['pronoun', 'pron.'],
  ['代词', 'pron.'],
  ['conj', 'conj.'],
  ['conjunction', 'conj.'],
  ['连词', 'conj.'],
  ['phrase', 'phr.'],
  ['短语', 'phr.'],
  ['phr', 'phr.'],
  ['int', 'int.'],
  ['interjection', 'int.'],
  ['感叹词', 'int.'],
  ['动词过去式', 'v.（过去式）'],
  ['动词过去分词', 'v.（过去分词）'],
  ['过去式', 'v.（过去式）'],
  ['过去分词', 'v.（过去分词）'],
  ['动词过去式/过去分词', 'v.（过去式/过去分词）'],
  ['past tense', 'v.（过去式）'],
  ['past participle', 'v.（过去分词）'],
  ['verb past tense', 'v.（过去式）'],
  ['verb past participle', 'v.（过去分词）'],
  ['verb past tense/past participle', 'v.（过去式/过去分词）'],
  ['v past tense', 'v.（过去式）'],
  ['v past participle', 'v.（过去分词）']
]);

function normalizePartOfSpeech(label: string): string | undefined {
  const normalized = label.trim().toLowerCase().replace(/\.$/u, '').replace(/\s*\/\s*/gu, '/').replace(/\s+/gu, ' ');
  return PART_OF_SPEECH_LABELS.get(normalized);
}

function isPartOfSpeechLabel(label: string): boolean {
  return /^(?:词性|part\s+of\s+speech|pos)$/iu.test(label.trim());
}

function isChineseMeaningLabel(label: string): boolean {
  return /^(?:中文释义|中文意思|chinese\s+meaning|meaning)$/iu.test(label.trim());
}

function isEnglishMeaningLabel(label: string): boolean {
  return /^(?:英文释义|英语释义|english\s+definition|concise\s+english\s+definition|definition)$/iu.test(label.trim());
}

const DIFFICULTY_FIELD_PATTERN = /^(?:(?:难度|词汇难度|词汇等级|等级)|cefr(?:\s*(?:level|difficulty|参考等级))?|level|difficulty|oxford\s*(?:\/\s*cefr)?(?:\s*(?:level|difficulty|难度|等级))?|牛津(?:词典)?(?:\s*(?:难度|等级))?)\s*[:：]?\s*((?:A|B|C)[12]|初级|中级|高级|未知|unknown)$/iu;

function splitDictionarySections(text: string): string[] {
  const sections: string[] = [];
  for (const fragment of text.split(/([;；\n]+)/u)) {
    if (/^[;；\n]+$/u.test(fragment)) continue;
    const part = fragment.trim();
    if (part.length === 0) continue;
    const label = part.match(/^([^:：]{1,64})\s*[:：]/u)?.[1]?.trim();
    const startsSection = DIFFICULTY_FIELD_PATTERN.test(part) || (label !== undefined && (
      normalizePartOfSpeech(label) !== undefined || isPartOfSpeechLabel(label) ||
      isChineseMeaningLabel(label) || isEnglishMeaningLabel(label) ||
      /^(?:动词原形|原形|词根|base(?:\s+form)?|lemma|英(?:式)?(?:音标|发音)?|美(?:式)?(?:音标|发音)?|拼音|pinyin|网络|例句|example|难度|词汇难度|词汇等级|等级|cefr(?:\s*(?:level|difficulty|参考等级))?|level|difficulty|oxford\s*(?:\/\s*cefr)?(?:\s*(?:level|difficulty|难度|等级))?|牛津(?:词典)?(?:\s*(?:难度|等级))?)$/iu.test(label)
    ));
    if (startsSection || sections.length === 0) {
      sections.push(part);
    } else {
      // A separator inside a meaning or an English definition belongs to that
      // field. Only recognized labels start another dictionary section.
      sections[sections.length - 1] += `；${part}`;
    }
  }
  return sections;
}

/**
 * Turns the provider's compact dictionary text into stable visual sections.
 * The provider is still allowed to return plain text; unrecognised text is
 * retained as a general definition instead of being discarded.
 */
export function parseDictionaryTranslation(translated: string): DictionaryDisplayData {
  const definitions: DictionaryDefinition[] = [];
  const unlabelled: string[] = [];
  let baseForm: string | undefined;
  let ukPronunciation: string | undefined;
  let usPronunciation: string | undefined;
  let pinyin: string | undefined;
  let difficulty: string | undefined;
  const examples: string[] = [];
  let networkMeaning: string | undefined;
  let pendingDefinition: {
    partOfSpeech: string;
    meanings: string[];
    englishMeaning?: string;
  } | undefined;

  const flushPendingDefinition = (): void => {
    if (pendingDefinition === undefined || pendingDefinition.meanings.length === 0) {
      pendingDefinition = undefined;
      return;
    }
    definitions.push({
      partOfSpeech: pendingDefinition.partOfSpeech,
      meaning: pendingDefinition.meanings.join('；'),
      ...(pendingDefinition.englishMeaning === undefined ? {} : { englishMeaning: pendingDefinition.englishMeaning })
    });
    pendingDefinition = undefined;
  };

  for (const rawPart of splitDictionarySections(translated)) {
    const part = rawPart.trim();
    if (part.length === 0) {
      continue;
    }
    const base = part.match(/^(?:动词原形|原形|词根|base(?:\s+form)?|lemma)\s*[:：]\s*(.+)$/iu);
    if (base !== null) {
      baseForm = base[1]?.trim();
      continue;
    }
    const pronunciation = part.match(/^(英(?:式)?|美(?:式)?)(?:音标|发音)?\s*[:：]\s*(.+)$/u);
    if (pronunciation !== null) {
      if (pronunciation[1]?.startsWith('英') === true) {
        ukPronunciation = pronunciation[2]?.trim();
      } else {
        usPronunciation = pronunciation[2]?.trim();
      }
      continue;
    }
    const pinyinPart = part.match(/^(?:拼音|pinyin)\s*[:：]\s*(.+)$/iu);
    if (pinyinPart !== null) {
      pinyin = pinyinPart[1]?.trim();
      continue;
    }
    const difficultyPart = part.match(DIFFICULTY_FIELD_PATTERN);
    if (difficultyPart !== null) {
      difficulty = difficultyPart[1]?.trim().toUpperCase();
      continue;
    }
    const examplePart = part.match(/^(?:例句|example)\s*[:：]\s*(.+)$/iu);
    if (examplePart !== null) {
      examples.push(examplePart[1]?.trim() ?? '');
      continue;
    }
    const network = part.match(/^网络\s*[:：]\s*(.+)$/u);
    if (network !== null) {
      flushPendingDefinition();
      networkMeaning = network[1]?.trim();
      continue;
    }
    const labelled = part.match(/^([^:：]{1,64})\s*[:：]\s*(.+)$/u);
    if (labelled !== null) {
      const label = labelled[1]?.trim() ?? '';
      const value = labelled[2]?.trim() ?? '';
      if (isPartOfSpeechLabel(label)) {
        const partOfSpeech = normalizePartOfSpeech(value);
        if (partOfSpeech !== undefined) {
          flushPendingDefinition();
          pendingDefinition = { partOfSpeech, meanings: [] };
          continue;
        }
      }
      if (isChineseMeaningLabel(label)) {
        if (pendingDefinition === undefined) {
          pendingDefinition = { partOfSpeech: '释义', meanings: [] };
        }
        pendingDefinition.meanings.push(value);
        continue;
      }
      if (isEnglishMeaningLabel(label)) {
        if (pendingDefinition !== undefined) {
          pendingDefinition.englishMeaning = value;
          flushPendingDefinition();
        } else {
          unlabelled.push(value);
        }
        continue;
      }
      const partOfSpeech = normalizePartOfSpeech(label);
      if (partOfSpeech !== undefined) {
        flushPendingDefinition();
        const [meaning, englishMeaning] = value.split(/\s*\|\|\s*/u, 2);
        definitions.push({
          partOfSpeech,
          meaning: meaning ?? '',
          ...(englishMeaning === undefined ? {} : { englishMeaning })
        });
        continue;
      }
    }
    if (pendingDefinition !== undefined) {
      pendingDefinition.meanings.push(part);
    } else {
      unlabelled.push(part);
    }
  }

  flushPendingDefinition();

  if (definitions.length === 0 && unlabelled.length > 0) {
    definitions.push({
      partOfSpeech: '释义',
      meaning: unlabelled.join('；')
    });
  } else if (unlabelled.length > 0) {
    definitions.push({
      partOfSpeech: '补充',
      meaning: unlabelled.join('；')
    });
  }

  return {
    ...(baseForm === undefined ? {} : { baseForm }),
    ...(ukPronunciation === undefined ? {} : { ukPronunciation }),
    ...(usPronunciation === undefined ? {} : { usPronunciation }),
    ...(pinyin === undefined ? {} : { pinyin }),
    ...(difficulty === undefined ? {} : { difficulty }),
    ...(examples.length === 0 ? {} : { examples }),
    definitions,
    ...(networkMeaning === undefined ? {} : { networkMeaning })
  };
}

export function inferRegularPastBaseForm(_original: string, _definitions: readonly DictionaryDefinition[]): string | undefined {
  // Spelling alone cannot distinguish liked/lik, hoped/hop, or irregular
  // forms. Omit an unknown lemma rather than displaying a fabricated word.
  return undefined;
}

export function shouldShowBaseForm(original: string, baseForm: string): boolean {
  const selected = original.trim().toLowerCase();
  const base = baseForm.trim().toLowerCase();
  return selected.length > 0 && base.length > 0 && selected !== base;
}

function appendSearchIcon(
  document: Document,
  parent: Element,
  size = 20,
  responsive = false
): void {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  icon.setAttribute('width', String(size));
  icon.setAttribute('height', String(size));
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.7');
  icon.setAttribute('stroke-linecap', 'round');
  icon.style.setProperty(
    'width',
    responsive ? `calc(${size}px * var(--hltv-zh-scale))` : `${size}px`
  );
  icon.style.setProperty(
    'height',
    responsive ? `calc(${size}px * var(--hltv-zh-scale))` : `${size}px`
  );
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '10.8');
  circle.setAttribute('cy', '10.8');
  circle.setAttribute('r', '6.8');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', 'm16 16 5 5');
  icon.append(circle, line);
  parent.appendChild(icon);
}

function appendSettingsIcon(document: Document, parent: Element): void {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  icon.setAttribute('width', '20');
  icon.setAttribute('height', '20');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.7');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.style.setProperty('width', 'calc(20px * var(--hltv-zh-scale))');
  icon.style.setProperty('height', 'calc(20px * var(--hltv-zh-scale))');
  const gear = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  gear.setAttribute('d', 'M10 3h4l.5 2.3 2 .9 2.1-.8 2 3.4-1.7 1.5v2.4l1.7 1.5-2 3.4-2.1-.8-2 .9L14 21h-4l-.5-2.3-2-.9-2.1.8-2-3.4 1.7-1.5v-2.4L3.4 9.8l2-3.4 2.1.8 2-.9Z');
  const center = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  center.setAttribute('cx', '12');
  center.setAttribute('cy', '12');
  center.setAttribute('r', '3.2');
  icon.append(gear, center);
  parent.appendChild(icon);
}

function appendCloseIcon(document: Document, parent: Element): void {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  icon.setAttribute('width', '20');
  icon.setAttribute('height', '20');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.7');
  icon.setAttribute('stroke-linecap', 'round');
  icon.style.setProperty('width', 'calc(20px * var(--hltv-zh-scale))');
  icon.style.setProperty('height', 'calc(20px * var(--hltv-zh-scale))');
  const first = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  first.setAttribute('d', 'm4 4 16 16');
  const second = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  second.setAttribute('d', 'm20 4-16 16');
  icon.append(first, second);
  parent.appendChild(icon);
}

function appendSpeakerIcon(document: Document, parent: Element): void {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  icon.setAttribute('width', '18');
  icon.setAttribute('height', '18');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.6');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.style.setProperty('width', 'calc(18px * var(--hltv-zh-scale))');
  icon.style.setProperty('height', 'calc(18px * var(--hltv-zh-scale))');
  const speaker = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  speaker.setAttribute('d', 'M4 10v4h4l5 4V6l-5 4H4Z');
  const wave = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  wave.setAttribute('d', 'M16 9.5a4 4 0 0 1 0 5');
  icon.append(speaker, wave);
  parent.appendChild(icon);
}

function appendStarIcon(document: Document, parent: Element, filled: boolean): void {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  icon.setAttribute('width', '20');
  icon.setAttribute('height', '20');
  icon.setAttribute('fill', filled ? 'currentColor' : 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.6');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.style.setProperty('width', 'calc(20px * var(--hltv-zh-scale))');
  icon.style.setProperty('height', 'calc(20px * var(--hltv-zh-scale))');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm12 3 2.78 5.63 6.22.9-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.92 1.06-6.2L3 9.53l6.22-.9L12 3Z');
  icon.appendChild(path);
  parent.appendChild(icon);
}

const selectionSpeech = new WeakMap<Document, () => void>();

function stopSelectionSpeech(document: Document): void {
  selectionSpeech.get(document)?.();
  selectionSpeech.delete(document);
}

function speakWord(
  document: Document,
  word: string,
  language: 'en-GB' | 'en-US' | 'zh-CN',
  onNotice: (message: string) => void
): void {
  const view = document.defaultView;
  if (view === null || typeof view.speechSynthesis?.speak !== 'function' || typeof view.SpeechSynthesisUtterance !== 'function') {
    onNotice('当前浏览器无法使用系统发音，请通过牛津官方词典核对入口听录音。');
    return;
  }
  stopSelectionSpeech(document);
  try {
    const utterance = new view.SpeechSynthesisUtterance(word);
    const voices = view.speechSynthesis.getVoices();
    const exactVoice = voices.find((voice) => voice.lang.replace(/_/gu, '-').toLowerCase() === language.toLowerCase());
    const fallbackVoice = voices.find((voice) => voice.lang.toLowerCase().startsWith(language.slice(0, 2)));
    const voice = exactVoice ?? fallbackVoice;
    if (voices.length > 0 && voice === undefined) {
      onNotice('系统没有可用的对应语言语音，请安装英语语音或通过牛津官网听录音。');
      return;
    }
    if (voice !== undefined) utterance.voice = voice;
    utterance.lang = voice?.lang ?? language;
    utterance.rate = 0.86;
    let active = true;
    const stop = (): void => {
      if (!active) return;
      active = false;
      utterance.onend = null;
      utterance.onerror = null;
      view.speechSynthesis.cancel();
    };
    selectionSpeech.set(document, stop);
    const finish = (): void => {
      active = false;
      if (selectionSpeech.get(document) === stop) selectionSpeech.delete(document);
    };
    utterance.onend = finish;
    utterance.onerror = (event) => {
      finish();
      if (event.error !== 'canceled' && event.error !== 'interrupted') {
        onNotice('系统发音失败，请检查系统语音设置，或通过牛津官网听录音。');
      }
    };
    view.speechSynthesis.speak(utterance);
    if (voices.length === 0) {
      onNotice('系统语音尚在初始化，将尝试默认语音；若无声音请稍后再点击。');
    } else if (exactVoice === undefined) {
      onNotice(language === 'zh-CN' ? '正在使用其他中文系统语音。' : `未安装${language === 'en-GB' ? '英式' : '美式'}语音，正在使用其他英语系统语音。`);
    } else {
      onNotice(`正在播放「${word}」的系统发音。`);
    }
  } catch {
    stopSelectionSpeech(document);
    onNotice('系统发音未能启动，请重试或通过牛津官网听录音。');
  }
}

function appendSpeakerButton(
  document: Document,
  parent: Element,
  word: string,
  language: 'en-GB' | 'en-US' | 'zh-CN',
  label: string,
  onNotice: (message: string) => void
): void {
  const button = document.createElement('button');
  button.type = 'button';
  const voiceLabel = language === 'zh-CN' ? '中文系统语音' : `${label}式系统语音`;
  button.setAttribute('aria-label', voiceLabel);
  button.title = `${voiceLabel}（非牛津录音）`;
  setStyles(button, {
    border: '0',
    padding: '0',
    backgroundColor: 'transparent',
    color: '#8e8e93',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center'
  });
  appendSpeakerIcon(document, button);
  button.addEventListener('click', () => speakWord(document, word, language, onNotice));
  parent.appendChild(button);
}

function createOxfordVerificationLinks(document: Document, word: string, includeSourceNote: boolean): HTMLElement {
  const section = document.createElement('div');
  setStyles(section, {
    color: 'var(--hltv-zh-card-muted)',
    fontSize: 'calc(12px * var(--hltv-zh-scale))',
    marginTop: 'calc(14px * var(--hltv-zh-scale))',
    lineHeight: '1.5'
  });
  if (includeSourceNote) {
    const description = document.createElement('div');
    description.textContent = '释义、音标与等级由模型提供；发音使用系统语音。';
    section.appendChild(description);
  }
  const links = document.createElement('div');
  setStyles(links, { display: 'flex', flexWrap: 'wrap', gap: 'calc(12px * var(--hltv-zh-scale))' });
  for (const [label, url] of [
    ['牛津官方词典核对 ↗', `https://www.oxfordlearnersdictionaries.com/search/english/direct/?q=${encodeURIComponent(word.trim().toLowerCase())}`],
    ['牛津官方等级词表 ↗', 'https://www.oxfordlearnersdictionaries.com/wordlists/oxford3000-5000']
  ] as const) {
    const link = document.createElement('a');
    link.textContent = label;
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    setStyles(link, { color: 'var(--hltv-zh-card-text)', textDecoration: 'underline', textUnderlineOffset: '3px' });
    links.appendChild(link);
  }
  section.appendChild(links);
  return section;
}

function installIconButtonHover(button: HTMLElement): void {
  const idle = 'rgba(118, 118, 128, 0.08)';
  const hover = 'rgba(118, 118, 128, 0.16)';
  setStyles(button, {
    backgroundColor: idle,
    borderRadius: '50%',
    transition: 'background-color 120ms ease, transform 120ms ease'
  });
  button.addEventListener('mouseenter', () => {
    setStyles(button, { backgroundColor: hover, transform: 'scale(1.03)' });
  });
  button.addEventListener('mouseleave', () => {
    setStyles(button, { backgroundColor: idle, transform: 'scale(1)' });
  });
}

function positionResultPopover(
  popover: HTMLElement,
  anchorRect: DOMRect | undefined,
  document: Document
): void {
  if (anchorRect === undefined) {
    return;
  }
  const view = document.defaultView;
  const viewportWidth = view?.innerWidth ?? 1024;
  const viewportHeight = view?.innerHeight ?? 768;
  const cardWidth = Math.min(460, viewportWidth - 32);
  const left = Math.min(
    Math.max(anchorRect.left, 16),
    Math.max(16, viewportWidth - cardWidth - 16)
  );
  const estimatedHeight = Math.min(390, viewportHeight - 32);
  const below = anchorRect.bottom + 10;
  const top = below + estimatedHeight <= viewportHeight - 16
    ? below
    : Math.max(16, anchorRect.top - estimatedHeight - 10);
  setStyles(popover, {
    left: `${left}px`,
    top: `${top}px`,
    right: 'auto',
    bottom: 'auto',
    maxHeight: `calc(100vh - 32px)`,
    overflowY: 'auto'
  });
}

function updatePopoverScale(popover: HTMLElement, fontScale: number): void {
  const width = popover.getBoundingClientRect().width;
  const scale = Math.max(0.72, Math.min(1.18, (width / 440) * clampFontScale(fontScale)));
  popover.style.setProperty('--hltv-zh-scale', scale.toFixed(3));
}

function installSelectionCardScaling(
  popover: HTMLElement,
  appearance: SelectionCardAppearance
): ResizeObserver | undefined {
  const updateScale = (): void => updatePopoverScale(popover, appearance.fontScale);
  updateScale();
  if (typeof ResizeObserver === 'undefined') {
    return undefined;
  }
  const observer = new ResizeObserver(updateScale);
  observer.observe(popover);
  return observer;
}

const selectionCardObservers = new WeakMap<HTMLElement, ResizeObserver>();
const selectionLookupVersions = new WeakMap<Document, number>();
const activeSelectionCards = new WeakMap<Document, HTMLElement>();
const appearanceWrites = new WeakMap<Document, {
  queue: Promise<void>;
  nextRevision: number;
  pending: Partial<Record<keyof SelectionCardAppearance, number>>;
}>();
const selectionCardBindings = new WeakMap<HTMLElement, {
  input: HTMLInputElement;
  refreshAppearance(): void;
  refreshFavorite(): void;
  dispose(): void;
}>();

const activeLookups = new WeakMap<Document, { controller: AbortController; card: HTMLElement }>();
function removeSelectionPopover(popover: HTMLElement): void {
  const lookup = activeLookups.get(popover.ownerDocument);
  if (lookup?.card === popover) {
    lookup.controller.abort();
    activeLookups.delete(popover.ownerDocument);
  }
  selectionCardBindings.get(popover)?.dispose();
  selectionCardBindings.delete(popover);
  selectionCardObservers.get(popover)?.disconnect();
  selectionCardObservers.delete(popover);
  if (activeSelectionCards.get(popover.ownerDocument) === popover) {
    activeSelectionCards.delete(popover.ownerDocument);
  }
  popover.remove();
}

function mountSelectionPopover(
  body: HTMLElement,
  popover: HTMLElement,
  appearance: SelectionCardAppearance
): void {
  if (popover.parentElement === null) {
    body.appendChild(popover);
    const observer = installSelectionCardScaling(popover, appearance);
    if (observer !== undefined) {
      selectionCardObservers.set(popover, observer);
    }
  }
  updatePopoverScale(popover, appearance.fontScale);
}

export function selectionFailureMessage(
  errorCode: TranslateFailureCode | undefined
): string | undefined {
  switch (errorCode) {
    case 'cancelled':
      return '查询已取消，可修改输入后重新查询。';
    case 'disabled':
      return '插件翻译已关闭，请先打开插件。';
    case 'settings-failure':
      return '翻译服务设置无法读取，请重新打开插件设置。';
    case 'provider-failure':
      return '翻译服务请求失败，请检查 API 地址、密钥和网络权限。';
    case 'provider-timeout':
      return '翻译服务响应超时，请检查网络或稍后重试。';
    case 'invalid-response':
      return '翻译服务返回格式无效，请检查模型或响应格式设置。';
    default:
      return undefined;
  }
}

function showSelectionTranslation(
  document: Document,
  original: string,
  translated: string,
  errorCode?: TranslateFailureCode,
  anchorRect?: DOMRect,
  onSearch?: (text: string, card: HTMLElement) => void,
  purpose: SelectionPurpose = 'dictionary',
  dictionaryStore?: {
    recordHistory(entry: DictionaryEntry): Promise<void>;
    isFavorite(query: string): Promise<boolean>;
    setFavorite(entry: DictionaryEntry, favorite: boolean): Promise<boolean>;
  },
  appearance: SelectionCardAppearance = { theme: 'system', cardColor: 'neutral', fontScale: 1 },
  appearanceStore?: { set(values: Record<string, unknown>): Promise<void> },
  learning: SelectionLearningOptions = {},
  existingPopover?: HTMLElement,
  pending = false
): void {
  const body = document.body;
  if (body === null) {
    return;
  }
  const reuseCard = existingPopover?.isConnected === true;
  const previousCard = document.querySelector<HTMLElement>('[data-hltv-zh-selection-result]');
  if (previousCard !== null && previousCard !== existingPopover) {
    removeSelectionPopover(previousCard);
  }
  const popover = reuseCard ? existingPopover : document.createElement('aside');
  const previousBindings = selectionCardBindings.get(popover);
  const previousInput = previousBindings?.input;
  const editedDraft = previousInput !== undefined && previousInput.value !== original
    ? previousInput.value : undefined;
  const restoreInputFocus = previousInput !== undefined && document.activeElement === previousInput;
  const caretStart = previousInput?.selectionStart ?? null;
  const caretEnd = previousInput?.selectionEnd ?? null;
  previousBindings?.dispose();
  popover.replaceChildren();
  popover.setAttribute('aria-busy', 'false');
  const englishUi = false;
  popover.setAttribute('data-hltv-zh-selection-result', '1');
  popover.setAttribute('data-hltv-zh-selection-ui', '1');
  popover.setAttribute('role', 'status');
  if (!reuseCard) {
    popover.style.setProperty('--hltv-zh-scale', '1');
  }
  const colorScheme = document.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  const applyCardTheme = (theme: ThemeMode, cardColor: CardColor): void => {
    const dark = theme === 'dark' || (
      theme === 'system' &&
      colorScheme?.matches === true
    );
    popover.style.setProperty('--hltv-zh-card-text', dark ? '#f5f5f7' : '#1d1d1f');
    popover.style.setProperty('--hltv-zh-card-muted', dark ? '#a1a1a6' : '#6e6e73');
    popover.style.setProperty('--hltv-zh-card-control', dark ? '#a1a1a6' : '#86868b');
    const surface = CARD_COLOR_SURFACES[cardColor] ?? CARD_COLOR_SURFACES.neutral;
    popover.style.setProperty('--hltv-zh-card-surface', dark ? surface.dark : surface.light);
    popover.style.setProperty('background-color', 'var(--hltv-zh-card-surface)');
    popover.style.setProperty('border-color', dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(60, 60, 67, 0.18)');
    popover.style.setProperty('color', 'var(--hltv-zh-card-text)');
  };
  applyCardTheme(appearance.theme, appearance.cardColor);
  if (!reuseCard) {
    setStyles(popover, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      width: 'min(440px, calc(100vw - 28px))',
      minWidth: '300px',
      minHeight: '180px',
      maxWidth: 'calc(100vw - 28px)',
      maxHeight: 'calc(100vh - 28px)',
      resize: 'both',
      overflow: 'auto',
      boxSizing: 'border-box',
      padding: 'calc(20px * var(--hltv-zh-scale)) calc(22px * var(--hltv-zh-scale)) calc(22px * var(--hltv-zh-scale))',
      border: '1px solid rgba(60, 60, 67, 0.18)',
      borderRadius: '16px',
      backgroundColor: 'var(--hltv-zh-card-surface)',
      color: 'var(--hltv-zh-card-text)',
      boxShadow: '0 12px 32px rgba(0, 0, 0, 0.14), 0 2px 8px rgba(0, 0, 0, 0.08)',
      backdropFilter: 'blur(20px) saturate(180%)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, "Microsoft YaHei", sans-serif',
      fontSize: 'calc(15px * var(--hltv-zh-scale))',
      lineHeight: '1.5'
    });
  }

  const header = document.createElement('div');
  setStyles(header, {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 'calc(12px * var(--hltv-zh-scale))',
    alignItems: 'center',
    minHeight: 'calc(38px * var(--hltv-zh-scale))'
  });
  const title = document.createElement('input');
  title.type = 'text';
  title.value = editedDraft ?? original;
  title.setAttribute('aria-label', '编辑要查询的单词或短语');
  setStyles(title, {
    minWidth: '0',
    flex: '1',
    border: '0',
    outline: '0',
    backgroundColor: 'transparent',
    color: 'var(--hltv-zh-card-text)',
    fontSize: 'calc(31px * var(--hltv-zh-scale))',
    lineHeight: '1.15',
    fontWeight: '500',
    letterSpacing: '-0.45px',
    wordBreak: 'break-word',
    padding: '0',
    fontFamily: 'inherit'
  });
  const controls = document.createElement('div');
  setStyles(controls, {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(4px * var(--hltv-zh-scale))'
  });
  const search = document.createElement('button');
  search.type = 'button';
  search.setAttribute('aria-label', '查询编辑后的单词');
  setStyles(search, {
    border: '0',
    background: 'transparent',
    color: 'var(--hltv-zh-card-control)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'calc(2px * var(--hltv-zh-scale))',
    width: 'calc(32px * var(--hltv-zh-scale))',
    height: 'calc(32px * var(--hltv-zh-scale))'
  });
  installIconButtonHover(search);
  appendSearchIcon(document, search, 20, true);
  const createCompactControl = (label: string, ariaLabel: string): HTMLButtonElement => {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = label;
    control.setAttribute('aria-label', ariaLabel);
    setStyles(control, {
      border: '0',
      background: 'transparent',
      color: 'var(--hltv-zh-card-control)',
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 'calc(2px * var(--hltv-zh-scale))',
      minWidth: 'calc(26px * var(--hltv-zh-scale))',
      height: 'calc(30px * var(--hltv-zh-scale))',
      fontFamily: 'inherit',
      fontSize: 'calc(13px * var(--hltv-zh-scale))',
      fontWeight: '600'
    });
    installIconButtonHover(control);
    return control;
  };
  const fontDown = createCompactControl('A−', '减小字号');
  const fontUp = createCompactControl('A+', '增大字号');
  const settingsButton = createCompactControl('', englishUi ? 'Open card settings' : '打开卡片设置');
  appendSettingsIcon(document, settingsButton);
  settingsButton.title = englishUi ? 'Card settings' : '卡片设置';
  settingsButton.setAttribute('aria-expanded', 'false');
  const settingsPanel = document.createElement('div');
  settingsPanel.hidden = true;
  settingsPanel.setAttribute('data-hltv-zh-card-settings', '1');
  setStyles(settingsPanel, {
    position: 'absolute',
    top: 'calc(58px * var(--hltv-zh-scale))',
    right: 'calc(14px * var(--hltv-zh-scale))',
    width: 'calc(218px * var(--hltv-zh-scale))',
    padding: 'calc(12px * var(--hltv-zh-scale))',
    border: '1px solid rgba(60, 60, 67, 0.16)',
    borderRadius: '14px',
    backgroundColor: 'var(--hltv-zh-card-surface)',
    color: 'var(--hltv-zh-card-text)',
    boxShadow: '0 12px 28px rgba(0, 0, 0, 0.16)',
    backdropFilter: 'blur(20px) saturate(180%)',
    zIndex: '3'
  });
  const settingsTitle = document.createElement('div');
  settingsTitle.textContent = englishUi ? 'Card settings' : '卡片设置';
  setStyles(settingsTitle, { fontWeight: '600' });
  const settingsHeader = document.createElement('div');
  setStyles(settingsHeader, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'calc(8px * var(--hltv-zh-scale))',
    marginBottom: 'calc(10px * var(--hltv-zh-scale))'
  });
  const settingsClose = createCompactControl('', '关闭卡片设置');
  settingsClose.title = '关闭卡片设置';
  appendCloseIcon(document, settingsClose);
  settingsClose.addEventListener('click', () => {
    settingsPanel.hidden = true;
    settingsButton.setAttribute('aria-expanded', 'false');
    settingsButton.focus();
  });
  settingsHeader.append(settingsTitle, settingsClose);
  const settingsSection = (label: string): HTMLElement => {
    const section = document.createElement('div');
    const heading = document.createElement('div');
    heading.textContent = label;
    setStyles(heading, {
      color: 'var(--hltv-zh-card-muted)',
      fontSize: 'calc(12px * var(--hltv-zh-scale))',
      margin: 'calc(8px * var(--hltv-zh-scale)) 0 calc(5px * var(--hltv-zh-scale))'
    });
    section.appendChild(heading);
    return section;
  };
  const settingsChoices = (buttons: readonly HTMLButtonElement[]): HTMLElement => {
    const row = document.createElement('div');
    setStyles(row, { display: 'flex', gap: 'calc(6px * var(--hltv-zh-scale))', flexWrap: 'wrap' });
    row.append(...buttons);
    return row;
  };
  const makeChoiceButton = (label: string, ariaLabel: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-label', ariaLabel);
    setStyles(button, {
      border: '1px solid rgba(60, 60, 67, 0.18)',
      borderRadius: '9px',
      padding: 'calc(5px * var(--hltv-zh-scale)) calc(8px * var(--hltv-zh-scale))',
      backgroundColor: 'transparent',
      color: 'var(--hltv-zh-card-text)',
      cursor: 'pointer',
      fontFamily: 'inherit',
      fontSize: 'calc(12px * var(--hltv-zh-scale))'
    });
    return button;
  };
  const persistAppearance = (field: keyof SelectionCardAppearance): void => {
    if (appearanceStore !== undefined) {
      const values = { [field]: field === 'fontScale' ? clampFontScale(appearance.fontScale) : appearance[field] };
      const writes = appearanceWrites.get(document) ?? { queue: Promise.resolve(), nextRevision: 0, pending: {} };
      const revision = ++writes.nextRevision;
      writes.pending[field] = revision;
      writes.queue = writes.queue
        .then(() => appearanceStore.set(values))
        .catch(() => showCardNotice('外观设置未保存，当前卡片仍保留预览；请重新选择后重试。'))
        .finally(() => {
          if (writes.pending[field] === revision) delete writes.pending[field];
        });
      appearanceWrites.set(document, writes);
    }
  };
  const themeChoices = [
    ['system', englishUi ? 'System' : '跟随系统'],
    ['light', englishUi ? 'Light' : '浅色'],
    ['dark', englishUi ? 'Dark' : '深色']
  ] as const;
  const themeButtons = themeChoices.map(([value, label]) => {
    const button = makeChoiceButton(label, `${englishUi ? 'Theme' : '主题'}：${label}`);
    button.addEventListener('click', () => {
      appearance.theme = value;
      applyCardTheme(appearance.theme, appearance.cardColor);
      updateThemeChoices();
      persistAppearance('theme');
    });
    return button;
  });
  const updateThemeChoices = (): void => {
    themeButtons.forEach((button, index) => {
      const value = themeChoices[index]?.[0];
      button.style.backgroundColor = value === appearance.theme ? 'rgba(0, 122, 255, 0.14)' : 'transparent';
      button.style.borderColor = value === appearance.theme ? '#007aff' : 'rgba(60, 60, 67, 0.18)';
      button.setAttribute('aria-pressed', String(value === appearance.theme));
    });
  };
  const colorChoices: readonly [CardColor, string][] = [
    ['neutral', englishUi ? 'Neutral' : '中性'],
    ['blue', englishUi ? 'Blue' : '蓝'],
    ['green', englishUi ? 'Green' : '绿'],
    ['sand', englishUi ? 'Sand' : '沙色'],
    ['rose', englishUi ? 'Rose' : '玫瑰']
  ];
  const colorButtons = colorChoices.map(([value, label]) => {
    const button = makeChoiceButton(label, `${englishUi ? 'Card color' : '卡片颜色'}：${label}`);
    // Swatches are always light, so their labels must stay dark even when the
    // surrounding card switches to a dark theme.
    setStyles(button, { color: '#1d1d1f', fontWeight: '600', textShadow: 'none', colorScheme: 'light' });
    button.addEventListener('click', () => {
      appearance.cardColor = value;
      applyCardTheme(appearance.theme, appearance.cardColor);
      updateColorChoices();
      persistAppearance('cardColor');
    });
    return button;
  });
  const updateColorChoices = (): void => {
    colorButtons.forEach((button, index) => {
      const value = colorChoices[index]?.[0];
      const surface = value === undefined ? CARD_COLOR_SURFACES.neutral : CARD_COLOR_SURFACES[value];
      button.style.backgroundColor = surface.swatch;
      button.style.borderColor = value === appearance.cardColor ? '#007aff' : 'rgba(60, 60, 67, 0.18)';
      button.style.boxShadow = value === appearance.cardColor ? '0 0 0 2px rgba(0, 122, 255, 0.18)' : 'none';
      button.setAttribute('aria-pressed', String(value === appearance.cardColor));
    });
  };
  const fontSection = settingsSection(englishUi ? 'Font size' : '字号');
  fontSection.appendChild(settingsChoices([fontDown, fontUp]));
  const themeSection = settingsSection(englishUi ? 'Appearance' : '明暗模式');
  themeSection.appendChild(settingsChoices(themeButtons));
  const colorSection = settingsSection(englishUi ? 'Card color' : '卡片颜色');
  colorSection.appendChild(settingsChoices(colorButtons));
  settingsPanel.append(settingsHeader, fontSection, themeSection, colorSection);
  const updateFontScale = (delta: number): void => {
    appearance.fontScale = clampFontScale(appearance.fontScale + delta);
    updatePopoverScale(popover, appearance.fontScale);
    persistAppearance('fontScale');
  };
  fontDown.addEventListener('click', () => updateFontScale(-0.05));
  fontUp.addEventListener('click', () => updateFontScale(0.05));
  settingsButton.addEventListener('click', () => {
    settingsPanel.hidden = !settingsPanel.hidden;
    settingsButton.setAttribute('aria-expanded', String(!settingsPanel.hidden));
  });
  updateThemeChoices();
  updateColorChoices();
  const refreshAppearance = (): void => {
    applyCardTheme(appearance.theme, appearance.cardColor);
    updateThemeChoices();
    updateColorChoices();
    updatePopoverScale(popover, appearance.fontScale);
  };
  const onSystemAppearanceChange = (): void => {
    if (appearance.theme === 'system') refreshAppearance();
  };
  colorScheme?.addEventListener('change', onSystemAppearanceChange);
  let refreshFavorite: (() => void) | undefined;
  selectionCardBindings.set(popover, {
    input: title,
    refreshAppearance,
    refreshFavorite: () => refreshFavorite?.(),
    dispose: () => {
      colorScheme?.removeEventListener('change', onSystemAppearanceChange);
      stopSelectionSpeech(document);
    }
  });
  activeSelectionCards.set(document, popover);
  let cardNotice: HTMLElement | undefined;
  const showCardNotice = (message: string): void => {
    if (!header.isConnected) return;
    if (cardNotice === undefined) {
      cardNotice = document.createElement('div');
      cardNotice.setAttribute('role', 'status');
      setStyles(cardNotice, {
        color: 'var(--hltv-zh-card-muted)',
        fontSize: 'calc(13px * var(--hltv-zh-scale))',
        marginTop: 'calc(8px * var(--hltv-zh-scale))',
        wordBreak: 'break-word'
      });
      popover.appendChild(cardNotice);
    }
    cardNotice.textContent = message;
  };
  const mountCard = (): void => {
    mountSelectionPopover(body, popover, appearance);
    if (editedDraft !== undefined) {
      showCardNotice(`下方结果来自「${original}」；当前输入尚未查询。`);
    }
    if (restoreInputFocus) {
      title.focus({ preventScroll: true });
      if (caretStart !== null && caretEnd !== null) title.setSelectionRange(caretStart, caretEnd);
    }
  };
  let favoriteButton: HTMLButtonElement | undefined;
  if (purpose === 'dictionary' && dictionaryStore !== undefined) {
    favoriteButton = document.createElement('button');
    favoriteButton.type = 'button';
    favoriteButton.setAttribute('aria-label', '收藏词典释义');
    setStyles(favoriteButton, {
      border: '0',
      background: 'transparent',
      color: 'var(--hltv-zh-card-control)',
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 'calc(2px * var(--hltv-zh-scale))',
      width: 'calc(32px * var(--hltv-zh-scale))',
      height: 'calc(32px * var(--hltv-zh-scale))'
    });
    installIconButtonHover(favoriteButton);
    appendStarIcon(document, favoriteButton, false);
    const updateFavorite = (isFavorite: boolean): void => {
      favoriteButton?.replaceChildren();
      if (favoriteButton !== undefined) {
        favoriteButton.style.color = isFavorite ? '#b8860b' : 'var(--hltv-zh-card-control)';
        favoriteButton.setAttribute('aria-label', isFavorite ? '取消收藏词典释义' : '收藏词典释义');
        appendStarIcon(document, favoriteButton, isFavorite);
      }
    };
    let favoriteRevision = 0;
    let currentFavorite = false;
    let favoriteLoaded = false;
    let savingFavorite = false;
    refreshFavorite = () => {
      if (savingFavorite || favoriteButton === undefined) return;
      const revision = ++favoriteRevision;
      favoriteButton.disabled = true;
      void dictionaryStore.isFavorite(original).then((value) => {
        if (revision !== favoriteRevision || !header.isConnected) return;
        favoriteLoaded = true;
        currentFavorite = value;
        updateFavorite(value);
      }).catch(() => {
        if (revision === favoriteRevision) showCardNotice('收藏状态读取失败，请重新查询后重试。');
      }).finally(() => {
        if (favoriteButton !== undefined && revision === favoriteRevision) {
          favoriteButton.disabled = !favoriteLoaded || popover.getAttribute('aria-busy') === 'true';
        }
      });
    };
    refreshFavorite();
    favoriteButton.addEventListener('click', () => {
      if (favoriteButton === undefined || favoriteButton.disabled) return;
      favoriteButton.disabled = true;
      savingFavorite = true;
      favoriteRevision += 1;
      const data = parseDictionaryTranslation(translated);
      const parsedBaseForm = data.baseForm ?? inferRegularPastBaseForm(original, data.definitions);
      const baseForm = parsedBaseForm !== undefined && shouldShowBaseForm(original, parsedBaseForm)
        ? parsedBaseForm
        : undefined;
      const entry: DictionaryEntry = {
        query: original,
        translated,
        ...(baseForm === undefined ? {} : { baseForm }),
        englishMeaning: data.definitions.map((item) => item.englishMeaning).filter((item): item is string => item !== undefined).join('；'),
        ...(data.difficulty === undefined ? {} : { difficulty: data.difficulty }),
        ...(data.pinyin === undefined ? {} : { pinyin: data.pinyin }),
        ...(data.examples === undefined ? {} : { examples: data.examples }),
        savedAt: Date.now()
      };
      void dictionaryStore.setFavorite(entry, !currentFavorite).then((value) => {
        currentFavorite = value;
        updateFavorite(value);
        showCardNotice(value ? '已收藏。' : '已取消收藏。');
      }).catch(() => showCardNotice('收藏保存失败，请重试。')).finally(() => {
        savingFavorite = false;
        if (favoriteButton !== undefined) {
          favoriteButton.disabled = popover.getAttribute('aria-busy') === 'true';
        }
        if (header.isConnected) refreshFavorite?.();
      });
    });
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭词典释义');
  setStyles(close, {
    border: '0',
    background: 'transparent',
    color: 'var(--hltv-zh-card-control)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'calc(2px * var(--hltv-zh-scale))',
    width: 'calc(32px * var(--hltv-zh-scale))',
    height: 'calc(32px * var(--hltv-zh-scale))'
  });
  installIconButtonHover(close);
  appendCloseIcon(document, close);
  // All three header controls share the same circle and cannot flex-shrink.
  for (const control of [settingsButton, search, close]) {
    setStyles(control, {
      width: 'calc(32px * var(--hltv-zh-scale))',
      minWidth: 'calc(32px * var(--hltv-zh-scale))',
      height: 'calc(32px * var(--hltv-zh-scale))',
      padding: '0',
      boxSizing: 'border-box',
      flexShrink: '0',
      lineHeight: '1'
    });
  }
  close.addEventListener('click', () => removeSelectionPopover(popover));
  let loadingStatus: HTMLElement | undefined;
  const submitSearch = (): void => {
    const nextText = title.value.trim();
    if (nextText.length === 0 || onSearch === undefined) {
      return;
    }
    if (loadingStatus === undefined) {
      loadingStatus = document.createElement('div');
      loadingStatus.setAttribute('role', 'status');
      setStyles(loadingStatus, {
        color: 'var(--hltv-zh-card-muted)',
        fontSize: 'calc(14px * var(--hltv-zh-scale))',
        marginTop: 'calc(8px * var(--hltv-zh-scale))',
        wordBreak: 'break-word'
      });
      header.after(loadingStatus);
    }
    if (!canTranslateSelection(nextText, learning.nativeLanguage)) {
      loadingStatus.textContent = '请输入要查询的英文单词或句子。';
      return;
    }
    loadingStatus.textContent = `正在查询「${nextText}」…`;
    popover.setAttribute('aria-busy', 'true');
    if (favoriteButton !== undefined) {
      favoriteButton.disabled = true;
    }
    onSearch(nextText, popover);
  };
  search.addEventListener('click', submitSearch);
  title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitSearch();
    }
  });
  title.addEventListener('input', () => {
    if (popover.getAttribute('aria-busy') !== 'true') {
      showCardNotice(title.value === original ? '' : `下方结果来自「${original}」；点击搜索或按 Enter 查询当前输入。`);
    }
  });
  controls.append(settingsButton, search, close);
  header.append(title, controls);
  popover.appendChild(settingsPanel);

  const divider = document.createElement('div');
  setStyles(divider, {
    height: '1px',
    backgroundColor: 'rgba(60, 60, 67, 0.18)',
    margin: 'calc(14px * var(--hltv-zh-scale)) 0 calc(14px * var(--hltv-zh-scale))'
  });

  const failure = selectionFailureMessage(errorCode);
  const fallback = translated === original ? '未找到中文释义，请检查翻译服务设置。' : translated;
  if (pending || failure !== undefined || translated === original) {
    const result = document.createElement('div');
    result.textContent = pending ? `正在查询「${original}」…` : failure ?? fallback;
    setStyles(result, {
      color: 'var(--hltv-zh-card-text)',
      fontSize: 'calc(16px * var(--hltv-zh-scale))',
      lineHeight: '1.6',
      wordBreak: 'break-word',
      whiteSpace: 'pre-wrap'
    });
    popover.append(header, divider, result);
    if (!pending) {
      const retry = createCompactControl('重试', '重试查询');
      setStyles(retry, { width: 'auto', padding: '8px 16px', marginTop: '12px', color: 'var(--hltv-zh-card-text)' });
      retry.addEventListener('click', submitSearch);
      popover.appendChild(retry);
    }
    if (!pending && purpose === 'dictionary') {
      popover.appendChild(createOxfordVerificationLinks(document, original, false));
    }
    if (!reuseCard) {
      positionResultPopover(popover, anchorRect, document);
    }
    mountCard();
    return;
  }

  if (purpose === 'sentence') {
    const result = document.createElement('div');
    result.textContent = translated;
    setStyles(result, {
      color: 'var(--hltv-zh-card-text)',
      fontSize: 'calc(20px * var(--hltv-zh-scale))',
      lineHeight: '1.55',
      wordBreak: 'break-word',
      whiteSpace: 'pre-wrap'
    });
    if (learning.audienceMode === 'learner' || learning.showOriginal === true) {
      const originalNode = document.createElement('div');
      originalNode.textContent = original;
      setStyles(originalNode, {
        color: 'var(--hltv-zh-card-muted)',
        fontSize: 'calc(15px * var(--hltv-zh-scale))',
        lineHeight: '1.45',
        marginBottom: 'calc(10px * var(--hltv-zh-scale))',
        whiteSpace: 'pre-wrap'
      });
      popover.append(header, divider, originalNode, result);
    } else {
      popover.append(header, divider, result);
    }
    mountCard();
    return;
  }

  const data = parseDictionaryTranslation(translated);
  const parsedBaseForm = data.baseForm ?? inferRegularPastBaseForm(original, data.definitions);
  const baseForm = parsedBaseForm !== undefined && shouldShowBaseForm(original, parsedBaseForm)
    ? parsedBaseForm
    : undefined;
  let baseNode: HTMLElement | undefined;
  if (baseForm !== undefined) {
    const base = document.createElement('div');
    setStyles(base, {
      color: 'var(--hltv-zh-card-muted)',
      fontSize: 'calc(15px * var(--hltv-zh-scale))',
      marginTop: 'calc(14px * var(--hltv-zh-scale))',
      paddingTop: 'calc(10px * var(--hltv-zh-scale))',
      borderTop: '1px solid rgba(60, 60, 67, 0.14)'
    });
    const baseLabel = document.createElement('strong');
    baseLabel.textContent = englishUi ? 'Base form  ' : '动词原形  ';
    const baseValue = document.createElement('span');
    baseValue.textContent = baseForm;
    setStyles(baseValue, { color: 'var(--hltv-zh-card-text)' });
    base.append(baseLabel, baseValue);
    baseNode = base;
  }
  if (data.ukPronunciation !== undefined || data.usPronunciation !== undefined || favoriteButton !== undefined) {
    const pronunciation = document.createElement('div');
    setStyles(pronunciation, {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 'calc(16px * var(--hltv-zh-scale))',
      alignItems: 'center',
      color: 'var(--hltv-zh-card-muted)',
      fontSize: 'calc(15px * var(--hltv-zh-scale))',
      marginBottom: 'calc(8px * var(--hltv-zh-scale))'
    });
    for (const [label, value] of [
      ['英', data.ukPronunciation],
      ['美', data.usPronunciation]
    ] as const) {
      if (value === undefined) {
        continue;
      }
      const item = document.createElement('span');
      setStyles(item, {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'calc(4px * var(--hltv-zh-scale))'
      });
      const labelNode = document.createElement('span');
      labelNode.textContent = value.startsWith('/') && value.endsWith('/')
        ? `${label} ${value}`
        : `${label} /${value}/`;
      const speaker = document.createElement('span');
      setStyles(speaker, { color: 'var(--hltv-zh-card-control)', display: 'inline-flex' });
      appendSpeakerButton(document, speaker, original, label === '英' ? 'en-GB' : 'en-US', label, showCardNotice);
      item.append(labelNode, speaker);
      pronunciation.appendChild(item);
    }
    if (favoriteButton !== undefined) {
      setStyles(favoriteButton, { marginLeft: 'auto' });
      pronunciation.appendChild(favoriteButton);
    }
    popover.append(header, divider, pronunciation);
  } else {
    popover.append(header, divider);
  }

  if (learning.showPinyin !== false && data.pinyin !== undefined) {
    const pinyin = document.createElement('div');
    pinyin.textContent = `${englishUi ? 'Pinyin' : '拼音'}  ${data.pinyin}`;
    setStyles(pinyin, {
      color: 'var(--hltv-zh-card-muted)',
      marginBottom: 'calc(8px * var(--hltv-zh-scale))'
    });
    const speaker = document.createElement('span');
    setStyles(speaker, { display: 'inline-flex', marginLeft: 'calc(6px * var(--hltv-zh-scale))' });
    appendSpeakerButton(document, speaker, original, 'zh-CN', englishUi ? 'Chinese' : '中文', showCardNotice);
    pinyin.appendChild(speaker);
    popover.appendChild(pinyin);
  }
  if (learning.showDifficulty !== false && data.difficulty !== undefined) {
    const level = document.createElement('div');
    level.textContent = `CEFR 参考等级（模型）  ${data.difficulty}`;
    setStyles(level, {
      color: 'var(--hltv-zh-card-muted)',
      marginBottom: 'calc(8px * var(--hltv-zh-scale))'
    });
    popover.appendChild(level);
  }

  const definitions = document.createElement('div');
  setStyles(definitions, {
    display: 'grid',
    gap: 'calc(8px * var(--hltv-zh-scale))'
  });
  for (const definition of data.definitions) {
    const row = document.createElement('div');
    setStyles(row, {
      display: 'grid',
      gridTemplateColumns: 'calc(70px * var(--hltv-zh-scale)) 1fr',
      gap: 'calc(10px * var(--hltv-zh-scale))'
    });
    const partOfSpeech = document.createElement('span');
    partOfSpeech.textContent = definition.partOfSpeech;
    setStyles(partOfSpeech, { color: 'var(--hltv-zh-card-muted)', fontWeight: '600', letterSpacing: '-0.1px' });
    const meaning = document.createElement('span');
    meaning.textContent = definition.meaning;
    setStyles(meaning, { color: 'var(--hltv-zh-card-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', letterSpacing: '-0.05px' });
    row.append(partOfSpeech, meaning);
    if (definition.englishMeaning !== undefined) {
      const english = document.createElement('span');
      english.textContent = definition.englishMeaning;
      setStyles(english, {
        gridColumn: '2',
        color: 'var(--hltv-zh-card-muted)',
        fontSize: '0.9em',
        lineHeight: '1.4',
        fontStyle: 'italic'
      });
      row.appendChild(english);
    }
    definitions.appendChild(row);
  }
  popover.appendChild(definitions);
  if (learning.showExamples !== false && data.examples !== undefined) {
    const examples = document.createElement('div');
    examples.textContent = `${englishUi ? 'Example' : '例句'}  ${data.examples.join('；')}`;
    setStyles(examples, {
      color: 'var(--hltv-zh-card-muted)',
      marginTop: 'calc(12px * var(--hltv-zh-scale))',
      whiteSpace: 'pre-wrap'
    });
    popover.appendChild(examples);
  }
  if (data.networkMeaning !== undefined) {
    const network = document.createElement('div');
    network.textContent = `${englishUi ? 'Web meaning' : '网络'}  ${data.networkMeaning}`;
    setStyles(network, {
      color: 'var(--hltv-zh-card-muted)',
      marginTop: 'calc(12px * var(--hltv-zh-scale))'
    });
    popover.appendChild(network);
  }
  popover.appendChild(createOxfordVerificationLinks(document, original, true));
  if (baseNode !== undefined) {
    popover.appendChild(baseNode);
  }
  if (!reuseCard) {
    positionResultPopover(popover, anchorRect, document);
  }
  mountCard();
  if (dictionaryStore !== undefined) {
    const dataEntry: DictionaryEntry = {
      query: original,
      translated,
      ...(baseForm === undefined ? {} : { baseForm }),
      englishMeaning: data.definitions.map((item) => item.englishMeaning).filter((item): item is string => item !== undefined).join('；'),
      ...(data.difficulty === undefined ? {} : { difficulty: data.difficulty }),
      ...(data.pinyin === undefined ? {} : { pinyin: data.pinyin }),
      ...(data.examples === undefined ? {} : { examples: data.examples }),
      savedAt: Date.now()
    };
    void dictionaryStore.recordHistory(dataEntry).catch(() => showCardNotice('本次查询未能保存到历史，请重试。'));
  }
}

function isSelectionUiNode(node: Node | null): boolean {
  const element = node?.nodeType === 1
    ? node as Element
    : node?.parentElement;
  if (element === null || element === undefined) {
    return false;
  }
  return element.closest('[data-hltv-zh-selection-ui]') !== null;
}

function selectionRange(document: Document): { text: string; rect: DOMRect } | undefined {
  const view = document.defaultView;
  const selection = view?.getSelection();
  if (selection === null || selection === undefined || selection.rangeCount === 0) {
    return undefined;
  }
  if (isSelectionUiNode(selection.anchorNode) || isSelectionUiNode(selection.focusNode)) {
    return undefined;
  }
  const text = selection.toString().trim();
  if (text.length === 0) {
    return undefined;
  }
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return undefined;
  }
  return { text, rect };
}

function positionMagnifier(button: HTMLElement, rect: DOMRect, document: Document): void {
  const view = document.defaultView;
  const viewportWidth = view?.innerWidth ?? 1024;
  const viewportHeight = view?.innerHeight ?? 768;
  const left = Math.min(Math.max(rect.right + 6, 8), viewportWidth - 36);
  const above = rect.top - 36;
  const top = above >= 8
    ? above
    : Math.min(rect.bottom + 6, viewportHeight - 36);
  setStyles(button, { left: `${left}px`, top: `${Math.max(8, top)}px` });
}

async function lookupSelection(
  document: Document,
  translator: ContextualTranslationAdapter & {
    translateWithContextDetailed?: (
      texts: string[],
      context: 'prose' | 'structured' | 'comment',
      purpose: TranslationPurpose,
      options?: { signal?: AbortSignal }
    ) => Promise<DetailedTranslationResult>;
  },
  text: string,
  anchorRect?: DOMRect,
  dictionaryStore?: {
    recordHistory(entry: DictionaryEntry): Promise<void>;
    isFavorite(query: string): Promise<boolean>;
    setFavorite(entry: DictionaryEntry, favorite: boolean): Promise<boolean>;
  },
  appearance: SelectionCardAppearance = { theme: 'system', cardColor: 'neutral', fontScale: 1 },
  appearanceStore?: { set(values: Record<string, unknown>): Promise<void> },
  learning: SelectionLearningOptions = {},
  existingPopover?: HTMLElement
): Promise<void> {
  if (!canTranslateSelection(text, learning.nativeLanguage)) {
    return;
  }
  const version = (selectionLookupVersions.get(document) ?? 0) + 1;
  selectionLookupVersions.set(document, version);
  activeLookups.get(document)?.controller.abort();
  const controller = new AbortController();
  const purpose = classifySelectionPurpose(text);
  const context = purpose === 'dictionary' ? 'structured' : 'prose';
  const onSearch = (nextText: string, card: HTMLElement): void => {
    void lookupSelection(document, translator, nextText, anchorRect, dictionaryStore, appearance, appearanceStore, learning, card);
  };
  if (existingPopover?.isConnected !== true) {
    showSelectionTranslation(document, text, text, undefined, anchorRect, onSearch, purpose,
      dictionaryStore, appearance, appearanceStore, learning, undefined, true);
    existingPopover = activeSelectionCards.get(document);
  }
  if (existingPopover === undefined) return;
  const card = existingPopover;
  const previous = activeLookups.get(document);
  previous?.card.removeAttribute('aria-busy');
  const progress = document.createElement('div');
  setStyles(progress, { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '12px', color: 'var(--hltv-zh-card-text)' });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = '取消查询';
  setStyles(cancel, { border: '1px solid currentColor', borderRadius: '12px', padding: '6px 12px', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 'calc(14px * var(--hltv-zh-scale))' });
  cancel.addEventListener('click', () => { cancel.disabled = true; controller.abort(); });
  progress.appendChild(cancel);
  card.appendChild(progress);
  card.setAttribute('aria-busy', 'true');
  activeLookups.set(document, { controller, card });
  let result: DetailedTranslationResult;
  try {
    result = translator.translateWithContextDetailed === undefined
      ? {
          translations: await translator.translateWithContext(
            [text],
            context,
            purpose
          )
        }
      : await translator.translateWithContextDetailed(
          [text],
          context,
          purpose,
          { signal: controller.signal }
        );
  } catch {
    result = { translations: [text], errorCode: 'provider-failure' };
  }
  progress.remove();
  if (activeLookups.get(document)?.controller === controller) activeLookups.delete(document);
  if (controller.signal.aborted) result = { translations: [text], errorCode: 'cancelled' };
  // Ignore superseded responses and never reopen a card closed during a request.
  if (selectionLookupVersions.get(document) !== version ||
      (existingPopover !== undefined && !existingPopover.isConnected)) {
    return;
  }
  showSelectionTranslation(
    document,
    text,
    result.translations[0] ?? text,
    result.errorCode,
    anchorRect,
    onSearch,
    purpose,
    dictionaryStore,
    appearance,
    appearanceStore,
    learning,
    existingPopover
  );
}

export interface SelectionMagnifierController {
  setAppearance(appearance: SelectionCardAppearance): void;
  setLearningOptions(options: SelectionLearningOptions): void;
  refreshFavorites(): void;
}

export function installSelectionMagnifier(options: {
  document: Document;
  translator: ContextualTranslationAdapter & {
    translateWithContextDetailed?: (
      texts: string[],
      context: 'prose' | 'structured' | 'comment',
      purpose: TranslationPurpose,
      options?: { signal?: AbortSignal }
    ) => Promise<DetailedTranslationResult>;
  };
  dictionaryStore?: {
    recordHistory(entry: DictionaryEntry): Promise<void>;
    isFavorite(query: string): Promise<boolean>;
    setFavorite(entry: DictionaryEntry, favorite: boolean): Promise<boolean>;
  };
  appearance?: SelectionCardAppearance;
  appearanceStore?: { set(values: Record<string, unknown>): Promise<void> };
  learning?: SelectionLearningOptions;
}): SelectionMagnifierController | undefined {
  const { document, translator, dictionaryStore } = options;
  let appearance = options.appearance ?? { theme: 'system' as const, cardColor: 'neutral' as const, fontScale: 1 };
  let learning = { ...(options.learning ?? {}) };
  const view = document.defaultView;
  if (view === null || view === undefined || document.body === null) {
    return undefined;
  }

  let button: HTMLButtonElement | undefined;
  let selectedText: string | undefined;
  let updateTimer: number | undefined;

  const removeButton = (): void => {
    if (button?.parentElement !== null && button?.parentElement !== undefined) {
      button.parentElement.removeChild(button);
    }
    button = undefined;
    selectedText = undefined;
  };

  const scheduleUpdate = (): void => {
    if (updateTimer !== undefined) {
      view.clearTimeout(updateTimer);
    }
    updateTimer = view.setTimeout(() => {
      updateTimer = undefined;
      const current = selectionRange(document);
      if (current === undefined) {
        removeButton();
        return;
      }
      if (!canTranslateSelection(current.text, learning.nativeLanguage)) {
        removeButton();
        return;
      }
      removeButton();
      selectedText = current.text;
      button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', '查询选中文本的中文词典释义');
      button.setAttribute('title', '查询中文词典释义');
      button.setAttribute('data-hltv-zh-selection-ui', '1');
      setStyles(button, {
        position: 'fixed',
        width: '28px',
        height: '28px',
        padding: '0',
        border: '1px solid rgba(60, 60, 67, 0.24)',
        borderRadius: '50%',
        backgroundColor: 'rgba(255, 255, 255, 0.42)',
        backgroundImage: 'linear-gradient(145deg, rgba(255, 255, 255, 0.72), rgba(255, 255, 255, 0.18))',
        color: '#1d1d1f',
        cursor: 'pointer',
        boxShadow: '0 8px 20px rgba(0, 0, 0, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.65)',
        backdropFilter: 'blur(18px) saturate(190%)',
        zIndex: '2147483647',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center'
      });
      installIconButtonHover(button);
      appendSearchIcon(document, button, 17);
      positionMagnifier(button, current.rect, document);
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        const text = selectedText;
        removeButton();
        if (text !== undefined) {
          void lookupSelection(document, translator, text, current.rect, dictionaryStore, appearance, options.appearanceStore, learning);
        }
      });
      document.body?.appendChild(button);
    }, 0);
  };

  document.addEventListener('selectionchange', scheduleUpdate, true);
  document.addEventListener('mouseup', scheduleUpdate, true);
  document.addEventListener('keyup', scheduleUpdate, true);
  const dismissOnViewportChange = (): void => {
    if (updateTimer !== undefined) view.clearTimeout(updateTimer);
    updateTimer = undefined;
    removeButton();
  };
  // A fixed button cannot retain a stale viewport anchor after scrolling.
  document.addEventListener('scroll', dismissOnViewportChange, true);
  view.addEventListener('resize', dismissOnViewportChange);
  document.addEventListener('mousedown', (event) => {
    if (!isSelectionUiNode(event.target as Node | null)) {
      removeButton();
    }
  }, true);
  return {
    refreshFavorites() {
      const card = activeSelectionCards.get(document);
      if (card !== undefined) selectionCardBindings.get(card)?.refreshFavorite();
    },
    setAppearance(next) {
      const pending = appearanceWrites.get(document)?.pending;
      // An earlier own-write notification must not replace a newer local click
      // waiting in the queue. Other fields remain free to sync across tabs.
      if (pending?.theme === undefined) appearance.theme = next.theme;
      if (pending?.cardColor === undefined) appearance.cardColor = next.cardColor;
      if (pending?.fontScale === undefined) appearance.fontScale = clampFontScale(next.fontScale);
      const card = activeSelectionCards.get(document);
      if (card !== undefined) selectionCardBindings.get(card)?.refreshAppearance();
    },
    setLearningOptions(next) {
      learning = { ...next };
    }
  };
}
