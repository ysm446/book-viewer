import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

/**
 * localStorage に覚える開閉状態(パネルなど)。次回起動時も同じ状態で開く。
 * 読めない・保存できない環境では initial のまま動く。
 */
export function useStoredFlag(
  key: string,
  initial: boolean
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(key)
      return v === null ? initial : v === '1'
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, value ? '1' : '0')
    } catch {
      // 保存できなくても今の画面では開閉できる
    }
  }, [key, value])
  return [value, setValue]
}
