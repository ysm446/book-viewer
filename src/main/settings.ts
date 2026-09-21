import { app } from 'electron'
import { join, dirname } from 'path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'

/** アプリ全体の既定設定。作品ごとの上書きは DB 側(page_direction)で持つ。 */
export interface AppSettings {
  /** 表示モード: 単ページ / 見開き2ページ */
  pageMode: 'single' | 'double'
  /** 見開き時、横長(横>縦)の画像は単独表示する */
  singleWhenLandscape: boolean
  /** 見開き時、最初のページ(表紙)を単独表示する(ペアを1つずらす) */
  coverAlone: boolean
  /** 既定の読み進め方向(漫画は右→左が一般的) */
  defaultDirection: 'rtl' | 'ltr'
  /** ページめくりエフェクト */
  pageTransition: 'none' | 'slide' | 'fade'
  /** 最近開いた管理ルート(先頭が最新)。起動時の自動復元にも使う */
  recentRoots: string[]
  /** 最後に開いていた作品 ID。起動時にその作品を自動で開く(ページ位置は DB 側で復元) */
  lastWorkId: string | null
  /** 文字起こしのエンジン(yomitoku: 文書 OCR / vlm: 読み込み済みの Vision LLM) */
  transcribeEngine: 'yomitoku' | 'vlm'
  /** ローカル LLM(OpenAI 互換エンドポイント)の設定 */
  llm: {
    /** 例: http://127.0.0.1:8080/v1 */
    baseUrl: string
    /** モデル名(llama-server では任意) */
    model: string
    /** 解析する代表ページ数 */
    samplePages: number
    /** llama-server 実行ファイルのパス(空なら vendor/llama_cpp から自動検出) */
    serverPath: string
    /** GGUF モデルを探すフォルダ(空ならプロジェクト直下の models/) */
    modelsDir: string
    /** コンテキスト長 */
    ctxSize: number
    /** ページ解析にシステムプロンプトを使うか */
    systemPromptEnabled: boolean
    /** システムプロンプト本文 */
    systemPrompt: string
    /** 前ページの説明を文脈として参照するか */
    usePageContext: boolean
    /** 参照する直前ページ数 */
    pageContextCount: number
    /** 物語の状態(あらすじ+登場人物)を走行更新して文脈に使うか */
    useStorySummary: boolean
    /** 物語の状態を更新する間隔(ページ数 M) */
    storySummaryEvery: number
    /** 思考(reasoning)モードを有効にするか(対応モデルのみ) */
    thinkingEnabled: boolean
    /** 作品チャットのシステムプロンプト(差し替え可能) */
    chatSystemPrompt: string
    /** 作品チャットの候補チップに、内容から作った質問を混ぜるか */
    chatDynamicSuggestions: boolean
  }
}

/** ページ解析の既定システムプロンプト(設定の「既定に戻す」と一致させる)。 */
export const DEFAULT_SYSTEM_PROMPT =
  'あなたは漫画の内容を客観的に説明するアシスタントです。' +
  '推測は控えめにし、画像に実際に見えたものを日本語で簡潔に記述してください。'

/** 作品チャットの既定システムプロンプト(backend analysis._CHAT_SYSTEM と一致させること)。 */
export const DEFAULT_CHAT_SYSTEM_PROMPT =
  'あなたは漫画作品について読者の質問に答えるアシスタントです。' +
  '以下の作品情報を踏まえ、日本語で簡潔に答えてください。' +
  '作品情報に無いことは推測であると断ったうえで述べ、断定しすぎないこと。'

const DEFAULTS: AppSettings = {
  pageMode: 'single',
  singleWhenLandscape: true,
  coverAlone: false,
  defaultDirection: 'rtl',
  pageTransition: 'slide',
  recentRoots: [],
  lastWorkId: null,
  transcribeEngine: 'yomitoku',
  llm: {
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'local',
    samplePages: 10,
    serverPath: '',
    modelsDir: '',
    ctxSize: 4096,
    systemPromptEnabled: false,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    usePageContext: false,
    pageContextCount: 2,
    useStorySummary: false,
    storySummaryEvery: 5,
    thinkingEnabled: false,
    chatSystemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
    chatDynamicSuggestions: true
  }
}

/** 設定はローカル環境として data/ フォルダに保存する。 */
function dataDir(): string {
  const dir = app.isPackaged
    ? join(dirname(app.getPath('exe')), 'data')
    : join(app.getAppPath(), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function settingsFile(): string {
  return join(dataDir(), 'settings.json')
}

/** 設定の部分更新パッチ。llm はネストごと部分更新できる。 */
export type AppSettingsPatch = Partial<Omit<AppSettings, 'llm'>> & {
  llm?: Partial<AppSettings['llm']>
}

/** 途中書き込みで壊れないよう、一時ファイルに書いてからリネームで置き換える。 */
function writeSettingsFile(file: string, value: AppSettings): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
  renameSync(tmp, file)
}

export function getSettings(): AppSettings {
  const file = settingsFile()
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<AppSettings>
      return { ...DEFAULTS, ...parsed, llm: { ...DEFAULTS.llm, ...(parsed.llm ?? {}) } }
    } catch {
      // 壊れたファイルは既定値で上書きせず退避し、既定値で動かす(復旧の余地を残す)。
      try {
        copyFileSync(file, `${file}.bak`)
      } catch {
        // 退避できなくても続行
      }
      return { ...DEFAULTS }
    }
  }
  // 初回は既定値を data/ に書き出しておく(ローカル環境として保存)。
  try {
    writeSettingsFile(file, DEFAULTS)
  } catch {
    // 書けなくても既定値で動かす
  }
  return { ...DEFAULTS }
}

export function setSettings(patch: AppSettingsPatch): AppSettings {
  const current = getSettings()
  const next: AppSettings = {
    ...current,
    ...patch,
    llm: { ...current.llm, ...(patch.llm ?? {}) }
  }
  try {
    writeSettingsFile(settingsFile(), next)
  } catch (err) {
    console.error('設定の保存に失敗:', err)
  }
  return next
}
