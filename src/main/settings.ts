import { app } from 'electron'
import { join, dirname } from 'path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'

/** アプリの配色テーマ。 */
export type AppTheme = 'dark' | 'light' | 'sepia'

/** アプリ全体の既定設定。本ごとの上書きは DB 側(page_direction)で持つ。 */
export interface AppSettings {
  /** 配色テーマ(黒 / 白 / セピア) */
  theme: AppTheme
  /** 表示モード: 単ページ / 見開き2ページ */
  pageMode: 'single' | 'double'
  /** 見開き時、横長(横>縦)の画像は単独表示する */
  singleWhenLandscape: boolean
  /** 見開き時、最初のページ(表紙)を単独表示する(ペアを1つずらす) */
  coverAlone: boolean
  /** 既定の読み進め方向(縦書きの本や漫画は右→左) */
  defaultDirection: 'rtl' | 'ltr'
  /** ページめくりエフェクト */
  pageTransition: 'none' | 'slide' | 'fade'
  /** 最近開いた管理ルート(先頭が最新)。起動時の自動復元にも使う */
  recentRoots: string[]
  /** 最後に開いていた本 ID。起動時にその本を自動で開く(ページ位置は DB 側で復元) */
  lastWorkId: string | null
  /** 文字起こしのエンジン(yomitoku: 文書 OCR / vlm: 読み込み済みの Vision LLM) */
  transcribeEngine: 'yomitoku' | 'vlm'
  /** ローカル LLM(OpenAI 互換エンドポイント)の設定 */
  llm: {
    /** 例: http://127.0.0.1:8080/v1 */
    baseUrl: string
    /** モデル名(llama-server では任意) */
    model: string
    /** llama-server 実行ファイルのパス(空なら vendor/llama_cpp から自動検出) */
    serverPath: string
    /** GGUF モデルを探すフォルダ(空ならプロジェクト直下の models/) */
    modelsDir: string
    /** コンテキスト長 */
    ctxSize: number
    /** 思考(reasoning)モードを有効にするか(対応モデルのみ) */
    thinkingEnabled: boolean
    /** 本のチャットのシステムプロンプト(差し替え可能) */
    chatSystemPrompt: string
    /** チャットの候補チップに、本文から作った質問を混ぜるか */
    chatDynamicSuggestions: boolean
    /** 本文に書かれていないことも、断ったうえで一般的な知識や推測で補って答えるか */
    chatGeneralKnowledge: boolean
    /** 最近読み込んだモデルのパス(先頭が最新)。モデル一覧で上に並べる */
    recentModels: string[]
  }
  /** 音声読み上げ(Irodori-TTS。日本語の本文をローカルで合成する) */
  tts: {
    /** Irodori-TTS-Server のフォルダ(空なら vendor/irodori-tts-server。別のアプリで入れたものも指せる) */
    serverDir: string
    /** モデルの置き場(Hugging Face のキャッシュをこの下の hf-cache に置く。空なら D:i-models	ts か既定のキャッシュ) */
    modelsDir: string
    /** 読み上げサーバーの URL(既定 http://127.0.0.1:8088。応答していれば起動せずに使う) */
    baseUrl: string
    /** 声の説明(キャプション)。参照音声が無いときの声づくりに使う */
    caption: string
    /** 参照音声(wav)のパス。指定すると声を真似る */
    refWav: string
    /** 合成の seed(同じ声を保つ。空なら毎回変わる) */
    seed: number | null
  }
}

/** 読み上げの声の既定の説明(Irodori-TTS のキャプション。参照音声が無いときに使う)。 */
export const DEFAULT_TTS_CAPTION = '穏やかで落ち着いた女性の声。本を朗読するように、はっきりと読む'

/** 本のチャットの既定システムプロンプト(backend chat._CHAT_SYSTEM と一致させること)。 */
export const DEFAULT_CHAT_SYSTEM_PROMPT =
  'あなたは、読者がいま読んでいる本について質問に答える読書アシスタントです。' +
  '以下の「本の情報」と「本文」をもとに、日本語で簡潔に答えてください。' +
  '本文を根拠にするときは、どのページか(p.○)を添えてください。'

/**
 * 以前の既定プロンプト。保存値がこれと同じ(手を加えていない)なら新しい既定に置き換える。
 * 本文に無いことの扱い(設定 chatGeneralKnowledge)と先の内容の扱い(本ごとのネタバレ防止)は
 * backend が基本人格の後ろに足すので、既定からは外した。
 */
const LEGACY_CHAT_SYSTEM_PROMPTS = [
  'あなたは、読者がいま読んでいる本について質問に答える読書アシスタントです。' +
    '以下の「本の情報」と「本文」(読者が読んだ範囲)を根拠に、日本語で簡潔に答えてください。' +
    '本文を根拠にするときは、どのページか(p.○)を添えてください。' +
    '本文に書かれていないことは、推測や一般的な知識であると断ったうえで述べ、断定しすぎないこと。' +
    '読者がまだ読んでいない先の内容(結末や種明かしなど)には触れないでください。',
  'あなたは漫画作品について読者の質問に答えるアシスタントです。' +
    '以下の作品情報を踏まえ、日本語で簡潔に答えてください。' +
    '作品情報に無いことは推測であると断ったうえで述べ、断定しすぎないこと。'
]

const DEFAULTS: AppSettings = {
  theme: 'dark',
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
    serverPath: '',
    modelsDir: '',
    ctxSize: 4096,
    thinkingEnabled: false,
    chatSystemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
    chatDynamicSuggestions: true,
    chatGeneralKnowledge: true,
    recentModels: []
  },
  tts: {
    serverDir: '',
    modelsDir: '',
    baseUrl: 'http://127.0.0.1:8088',
    caption: DEFAULT_TTS_CAPTION,
    refWav: '',
    seed: 1234
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

/** 設定の部分更新パッチ。llm / tts はネストごと部分更新できる。 */
export type AppSettingsPatch = Partial<Omit<AppSettings, 'llm' | 'tts'>> & {
  llm?: Partial<AppSettings['llm']>
  tts?: Partial<AppSettings['tts']>
}

/** ネストした設定(llm / tts)を、既知の項目だけ既定値に重ねて読む。 */
function nested<K extends 'llm' | 'tts'>(parsed: Partial<AppSettings>, key: K): AppSettings[K] {
  const saved = (parsed[key] ?? {}) as Record<string, unknown>
  const out = { ...DEFAULTS[key] } as Record<string, unknown>
  for (const k of Object.keys(DEFAULTS[key])) {
    if (k in saved) out[k] = saved[k]
  }
  return out as AppSettings[K]
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
      // 今は使っていない項目(漫画向けの解析の設定など)は読み込み時に落とす(次の保存で消える)。
      const llm = nested(parsed, 'llm')
      const tts = nested(parsed, 'tts')
      // 手を加えていない旧既定のままなら、今の既定に置き換える。
      if (LEGACY_CHAT_SYSTEM_PROMPTS.includes(llm.chatSystemPrompt)) {
        llm.chatSystemPrompt = DEFAULT_CHAT_SYSTEM_PROMPT
      }
      // トップレベルも既知の項目だけを残す(旧 manga-viewer 時代のキーを引きずらない)。
      const top = { ...DEFAULTS }
      for (const key of Object.keys(DEFAULTS) as (keyof AppSettings)[]) {
        if (key !== 'llm' && key !== 'tts' && key in parsed) {
          ;(top as Record<string, unknown>)[key] = (parsed as Record<string, unknown>)[key]
        }
      }
      return { ...top, llm, tts }
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
    llm: { ...current.llm, ...(patch.llm ?? {}) },
    tts: { ...current.tts, ...(patch.tts ?? {}) }
  }
  try {
    writeSettingsFile(settingsFile(), next)
  } catch (err) {
    console.error('設定の保存に失敗:', err)
  }
  return next
}
