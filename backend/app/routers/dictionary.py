from fastapi import APIRouter, HTTPException

from .. import dictionary

router = APIRouter()


@router.get("/dictionary")
def lookup(word: str) -> dict:
    """英単語を英和辞書(EJDict)で引く。初回は辞書データを取得するので時間がかかる。"""
    if not word.strip() or len(word) > 64:
        raise HTTPException(status_code=400, detail="単語を指定してください")
    try:
        return dictionary.lookup(word.strip())
    except dictionary.DictionaryError as e:
        raise HTTPException(status_code=503, detail=str(e))
