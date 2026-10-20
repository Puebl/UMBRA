export type Mode = 'words' | 'sentences' | 'code' | 'symbols';
export type Language = 'ru' | 'en';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type CodeLanguage = 'javascript' | 'python' | 'html';
export type Duration = 30 | 60 | 120;
export interface ExerciseConfig {
  mode: Mode;
  language: Language;
  difficulty: Difficulty;
  duration: Duration;
  codeLanguage: CodeLanguage;
}
export interface MistakeStat { expected: string; count: number }
export interface SessionResult {
  id: string;
  createdAt: string;
  mode: Mode;
  language: Language;
  difficulty: Difficulty;
  durationMs: number;
  correct: number;
  errors: number;
  maxCombo: number;
  score: number;
  xp: number;
  cpm: number;
  wpm: number;
  accuracy: number;
  mistakes: MistakeStat[];
}
export const AVATAR_IDS = ['initials', 'orbit', 'bolt', 'shield', 'flame', 'crown'] as const;
export type AvatarId = typeof AVATAR_IDS[number];
export type InterfaceLanguage = 'ru' | 'en';
export interface ProfileSettings {
  name: string;
  avatar: AvatarId;
  interfaceLanguage: InterfaceLanguage;
  showInLeaderboard: boolean;
}
export type ProfileSettingsUpdate = Partial<ProfileSettings>;
export interface Profile extends ProfileSettings {
  id: string;
  email: string;
  xp: number;
  sessions: SessionResult[];
  profileVersion: number;
}
export interface LeaderboardEntry {
  userId: string;
  name: string;
  avatar: AvatarId;
  cpm: number;
  accuracy: number;
  xp: number;
  sessions: number;
}
export interface LeaderboardResponse { entries: LeaderboardEntry[]; updatedAt: string }
export const MODE_LABELS: Record<Mode, string> = {
  words: 'Слова', sentences: 'Предложения', code: 'Код', symbols: 'Символы',
};
export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: 'Начальный', medium: 'Уверенный', hard: 'Мастер',
};
export function levelFromXp(xp: number) {
  const level = Math.floor(Math.sqrt(Math.max(0, xp) / 250)) + 1;
  const base = 250 * (level - 1) ** 2;
  const next = 250 * level ** 2;
  return { level, current: xp - base, required: next - base, next };
}
export function sessionXp(correct: number, accuracy: number, maxCombo: number) {
  return Math.round(correct + (accuracy >= 98 ? correct * 0.25 : 0) + Math.min(maxCombo, 200) * 0.5);
}
export const DEFAULT_CONFIG: ExerciseConfig = {
  mode: 'words', language: 'ru', difficulty: 'easy', duration: 60, codeLanguage: 'javascript',
};
