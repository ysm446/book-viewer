"""人物ノートのネタバレ境界・永続化・更新・API を検証する。"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import notes
from app.db import connect
from app.progress import Cancelled
from app.routers.notes import router


def fact(subject, description, quote, kind='person', target='', unit=0):
    return dict(subject=subject, description=description, quote=quote, kind=kind,
                target=target, unit=unit, inferred=False)


class NotesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.book = {'page_count': 12, 'chapters': [
            {'page': 0, 'title': '出会い', 'level': 1}, {'page': 6, 'title': '正体', 'level': 1}]}
        self.doc = {'pages_done': 12, 'blocks': [
            {'page': 0, 'kind': 'p', 'md': '太郎は学生。花子は太郎の友人。'},
            {'page': 8, 'kind': 'p', 'md': '黒衣の男は太郎だった。花子は太郎に敵対した。'}]}
        self.source = notes.units(self.doc)
        self.outputs = [fact('太郎', '学生', '太郎は学生。'),
                        fact('花子', '太郎の友人', '花子は太郎の友人。', 'relation', '太郎'),
                        fact('黒衣の男', '太郎の別名', '黒衣の男は太郎だった。', 'alias', '太郎', 1),
                        fact('花子', '太郎に敵対', '花子は太郎に敵対した。', 'relation', '太郎', 1)]
        self.data = notes._read(self.folder)
        valid = notes.validate_facts({'facts': self.outputs}, self.source)
        self.data['units'] = {k: {'facts': v} for k, v in valid.items()}
        notes._save(self.folder, self.data)
        # 名前の整理(LLM)は専用のテストで確かめる。
        self.tidy = notes.tidy_names
        for mock in (patch.object(notes, '_source', return_value=(self.folder, self.book, self.doc)),
                     patch.object(notes, 'tidy_names')):
            mock.start()
            self.addCleanup(mock.stop)

    def test_spoiler_hides_future_alias_description_and_relationship(self):
        view = notes.get(self.folder, 'book', 3)
        text = json.dumps(view, ensure_ascii=False)
        self.assertNotIn('黒衣', text)
        self.assertNotIn('敵対', text)
        self.assertNotIn('正体', text)
        self.assertEqual(len(view['people']), 2)
        self.assertEqual(len(view['relations']), 1)
        self.assertIn('黒衣', json.dumps(notes.get(self.folder, 'book', 9), ensure_ascii=False))

    def test_guard_off_and_chapter_vs_cumulative(self):
        notes.change(self.folder, 'book', {'spoiler_guard': False})
        one = notes.get(self.folder, 'book', 0, 6, 'chapter')
        through = notes.get(self.folder, 'book', 0, 6, 'through')
        self.assertEqual(len(one['relations']), 1)
        self.assertEqual(len(through['relations']), 2)
        self.assertIn('敵対', one['relations'][0]['description'])
        self.assertFalse(notes._read(self.folder)['spoiler_guard'])

    def test_rejects_fabricated_quotes_and_names(self):
        invalid = [fact('太郎', '王', '存在しない引用'), fact('次郎', '学生', '太郎は学生。')]
        found = notes.validate_facts({'facts': invalid}, self.source)
        self.assertFalse(any(found.values()))
        with self.assertRaises(notes.NotesError):
            notes.validate_facts({}, self.source)

    def test_cross_page_information_waits_until_end(self):
        doc = {'blocks': [{'page': 0, 'kind': 'p', 'md': '太郎は\n黒衣の男だった。', 'cont': [[5, 4]]}]}
        source = notes.units(doc)
        valid = notes.validate_facts({'facts': [fact('太郎', '正体', '黒衣の男だった。')]}, source)
        data = {**self.data, 'units': {k: {'facts': v} for k, v in valid.items()}}
        self.assertFalse(notes.project(data, source, page=0)['people'])
        self.assertTrue(notes.project(data, source, page=5)['people'])

    def test_manual_merge_is_page_gated_and_reversible(self):
        notes.change(self.folder, 'book', {'merge_subject': '太郎', 'merge_target': '花子', 'revealed': 4})
        self.assertEqual(len(notes.get(self.folder, 'book', 3)['people']), 2)
        self.assertEqual(len(notes.get(self.folder, 'book', 4)['people']), 1)
        notes.change(self.folder, 'book', {'clear_merges': True})
        self.assertEqual(len(notes.get(self.folder, 'book', 4)['people']), 2)

    def people(self, text, names, page=9):
        """names: (名前, 判明ページ) の順に 1 件ずつ人物情報を作り、まとめた結果を返す。"""
        doc = {'blocks': [{'page': p, 'kind': 'p', 'md': f'{n}は{text}。'} for n, p in names]}
        source = notes.units(doc)
        valid = notes.validate_facts({'facts': [fact(n, text, f'{n}は{text}。', unit=i)
                                                for i, (n, _) in enumerate(names)]}, source)
        data = {**self.data, 'units': {k: {'facts': v} for k, v in valid.items()}}
        return {p['name']: p['aliases'] for p in notes.project(data, source, page=page)['people']}

    def test_spelling_variants_and_partial_names_are_one_person(self):
        found = self.people('社長', [('ジェンスン', 0), ('ジェンスン·フアン', 0), ('ジェンスン・ファン', 1),
                                    ('ブリエム', 2), ('カーティス・プリエム', 2), ('カーティス', 3)])
        self.assertEqual(set(found), {'ジェンスン·フアン', 'カーティス・プリエム'})
        self.assertEqual(set(found['ジェンスン·フアン']), {'ジェンスン', 'ジェンスン・ファン'})
        # 短い名前は濁点違いの別人でありうる。
        self.assertEqual(len(self.people('学生', [('ジュン', 0), ('シュン', 0)])), 2)

    def test_partial_name_shared_by_several_people_stays_separate(self):
        found = self.people('技術者', [('ジェフ·スミス', 0), ('ロス·スミス', 1), ('スミス', 2)])
        self.assertEqual(len(found), 3)
        # 初出時点で一人に決まっていた呼び名は、後から同じ名の別人が出ても変えない。
        names = [('クリス·マラコウスキー', 0), ('クリス', 1), ('クリス·ディスキン', 5)]
        self.assertEqual(self.people('技術者', names)['クリス·マラコウスキー'], ['クリス'])
        # 未読の氏名ではまとめない。
        self.assertEqual(set(self.people('技術者', [('プリエム', 0), ('カーティス·プリエム', 5)], page=3)), {'プリエム'})

    def test_people_with_more_information_come_first(self):
        names = [('脇役', 0)] + [('主役', p) for p in (1, 2, 3)]
        doc = {'blocks': [{'page': p, 'kind': 'p', 'md': f'{n}は{p}番。'} for n, p in names]}
        source = notes.units(doc)
        valid = notes.validate_facts({'facts': [fact(n, f'{p}番', f'{n}は{p}番。', unit=i)
                                                for i, (n, p) in enumerate(names)]}, source)
        data = {**self.data, 'units': {k: {'facts': v} for k, v in valid.items()}}
        people = notes.project(data, source, page=9)['people']
        self.assertEqual([(p['name'], p['minor']) for p in people], [('主役', False), ('脇役', True)])
        # 主な人物がまだいない範囲では畳まない。
        self.assertFalse(notes.project(data, source, page=1)['people'][0]['minor'])

    def test_llm_tidies_names_but_only_spelling_variants(self):
        doc = {'blocks': [{'page': p, 'kind': 'p', 'md': f'{n}は{d}。'} for p, (n, d) in enumerate(
            [('ジェンスン·フアン', '社長'), ('Jensen Huang', '著者'), ('エヌビディア', '会社'), ('黒衣の男', '謎')])]}
        source = notes.units(doc)
        valid = notes.validate_facts({'facts': [fact(n, '説明', u['text'], unit=i) for i, (u, n) in enumerate(
            zip(source, ['ジェンスン·フアン', 'Jensen Huang', 'エヌビディア', '黒衣の男']))]}, source)
        notes._save(self.folder, {**self.data, 'units': {k: {'facts': v} for k, v in valid.items()}})
        # 黒衣の男 = ジェンスン は表記の違いではないので、LLM が同一と答えても採用しない。
        answer = {'items': [{'index': 0, 'person': True, 'same': -1}, {'index': 1, 'person': True, 'same': 0},
                            {'index': 2, 'person': False, 'same': -1}, {'index': 3, 'person': True, 'same': 0}]}
        with patch.object(notes.llm, 'chat', return_value=json.dumps(answer)) as chat:
            self.tidy(self.folder, source, 'unused')
            self.tidy(self.folder, source, 'unused')
            self.assertEqual(chat.call_count, 1)
        data = notes._read(self.folder)
        people = {p['name']: p for p in notes.project(data, source, page=9)['people']}
        self.assertEqual(set(people), {'ジェンスン·フアン', 'エヌビディア', '黒衣の男'})
        self.assertEqual(people['ジェンスン·フアン']['aliases'], ['Jensen Huang'])
        self.assertTrue(people['エヌビディア']['thing'])
        self.assertFalse(people['黒衣の男']['thing'])
        # 英字表記が未読のうちは別表記として見せない。
        self.assertNotIn('Jensen', json.dumps(notes.project(data, source, page=0), ensure_ascii=False))

    def test_user_can_split_an_alias_and_mark_a_non_person(self):
        doc = {'blocks': [{'page': 0, 'kind': 'p', 'md': f'{n}は技術者。'} for n in ('クリス·マラコウスキー', 'クリス')]}
        source = notes.units(doc)
        valid = notes.validate_facts({'facts': [fact(n, '技術者', f'{n}は技術者。', unit=i) for i, n in enumerate(
            ('クリス·マラコウスキー', 'クリス'))]}, source)
        notes._save(self.folder, {**self.data, 'units': {k: {'facts': v} for k, v in valid.items()}})

        def people():
            return notes.project(notes._read(self.folder), source, page=0)['people']

        self.assertEqual(len(people()), 1)
        notes.change(self.folder, 'book', {'names': ['クリス'], 'apart': True})
        self.assertEqual({p['name'] for p in people()}, {'クリス·マラコウスキー', 'クリス'})
        notes.change(self.folder, 'book', {'names': ['クリス'], 'person': False})
        self.assertEqual({p['name']: p['thing'] for p in people()}, {'クリス·マラコウスキー': False, 'クリス': True})
        notes.change(self.folder, 'book', {'clear_apart': True})
        self.assertEqual(len(people()), 1)
        notes.change(self.folder, 'book', {'names': ['クリス·マラコウスキー', 'クリス'], 'person': True})
        self.assertFalse(people()[0]['thing'])

    def test_summary_uses_visible_facts_and_is_not_shown_earlier(self):
        def taro(page):
            return next(p for p in notes.get(self.folder, 'book', page)['people'] if p['name'] == '太郎')

        with patch.object(notes.llm, 'chat', return_value='太郎は学生で、黒衣の男の正体。') as chat:
            notes.summarize(self.folder, 'book', 'unused', taro(9)['id'], 9)
            notes.summarize(self.folder, 'book', 'unused', taro(9)['id'], 9)
            self.assertEqual(chat.call_count, 1)
            self.assertIn('黒衣の男', chat.call_args.args[1][0]['content'])
        self.assertIn('正体', taro(9)['summary'])
        # 先の位置で作った紹介文は、前の位置では出さない。
        self.assertEqual(taro(3)['summary'], '')
        with patch.object(notes.llm, 'chat', return_value='太郎は学生。') as chat:
            notes.summarize(self.folder, 'book', 'unused', taro(3)['id'], 3)
            self.assertNotIn('黒衣', chat.call_args.args[1][0]['content'])
        self.assertEqual(taro(3)['summary'], '太郎は学生。')

    def test_edits_survive_resume_and_changed_source_is_not_shown(self):
        original = self.data['units'][self.source[0]['key']]['facts'][0]
        notes.change(self.folder, 'book', {'fact_id': original['id'], 'description': '学生（訂正）'})
        with patch.object(notes.llm, 'chat') as chat:
            notes.run(self.folder, 'book', 'unused')
            chat.assert_not_called()
        self.assertIn('訂正', json.dumps(notes.get(self.folder, 'book', 3), ensure_ascii=False))
        self.doc['blocks'][0]['md'] = '内容を書き直した。'
        view = notes.get(self.folder, 'book', 3)
        self.assertEqual(view['checked'], 1)
        self.assertFalse(view['people'])
        self.assertIn(original['id'], notes._read(self.folder)['edits'])

    def test_cancel_resume_and_concurrent_setting_update(self):
        notes._save(self.folder, {**self.data, 'units': {}})
        with self.assertRaises(Cancelled):
            notes.run(self.folder, 'book', 'unused', cancel_check=lambda: True)
        self.assertFalse(notes._read(self.folder)['units'])

        def response(*args, **kwargs):
            notes.change(self.folder, 'book', {'spoiler_guard': False})
            prompt = args[1][0]['content']
            output = self.outputs[2:] if '黒衣の男は太郎だった。' in prompt else self.outputs[:2]
            return json.dumps({'facts': [{**f, 'unit': 0} for f in output]})

        with patch.object(notes.llm, 'chat', side_effect=response) as chat:
            notes.run(self.folder, 'book', 'unused')
            notes.run(self.folder, 'book', 'unused')
            self.assertEqual(chat.call_count, 2)
            self.assertNotIn('黒衣の男は太郎だった。', chat.call_args_list[0].args[1][0]['content'])
        saved = notes._read(self.folder)
        self.assertEqual(len(saved['units']), 2)
        self.assertFalse(saved['spoiler_guard'])

    def test_corrupt_file_is_not_overwritten(self):
        path = self.folder / 'notes' / 'people.json'
        path.write_text('{bad', encoding='utf-8')
        with self.assertRaises(notes.NotesError):
            notes.change(self.folder, 'book', {'spoiler_guard': False})
        self.assertEqual(path.read_text(encoding='utf-8'), '{bad')

    def test_hidden_can_be_restored(self):
        original = self.data['units'][self.source[0]['key']]['facts'][0]
        notes.change(self.folder, 'book', {'fact_id': original['id'], 'hidden': True})
        self.assertNotIn('学生', json.dumps(notes.get(self.folder, 'book', 3), ensure_ascii=False))
        notes.change(self.folder, 'book', {'restore_hidden': True})
        self.assertIn('学生', json.dumps(notes.get(self.folder, 'book', 3), ensure_ascii=False))

    def test_api_filter_and_validation(self):
        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)
        query = {'root': str(self.folder), 'page': 3}
        response = client.get('/works/book/notes', params=query)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('黒衣', response.text)
        self.assertEqual(client.patch('/works/book/notes', json={
            'root': str(self.folder), 'description': ''}).status_code, 422)
        self.assertEqual(client.get('/works/book/notes', params={**query, 'mode': 'invalid'}).status_code, 422)
        with patch('app.routers.notes.jobs.enqueue', return_value={'pending': []}) as enqueue:
            self.assertEqual(client.post('/works/book/notes', json={'root': str(self.folder)}).status_code, 200)
            self.assertEqual(enqueue.call_args.args[2], 'notes')


class NotesIntegrationTest(unittest.TestCase):
    def test_real_book_folder_content_and_persisted_api(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = root / 'sample'
            (folder / 'pages').mkdir(parents=True)
            (folder / 'source').mkdir()
            book = {'schema': 1, 'id': 'sample', 'title': '人物テスト', 'source': 'source/original.zip',
                    'page_count': 1, 'chapters': [], 'language': 'ja'}
            (folder / 'book.json').write_text(json.dumps(book), encoding='utf-8')
            (folder / 'pages' / '0001.md').write_text('太郎は学生。', encoding='utf-8')
            with connect(root) as conn:
                conn.execute('INSERT INTO works (id, rel_path, title, page_count, added_at) VALUES (?, ?, ?, ?, ?)',
                             ('sample', 'sample/source/original.zip', '人物テスト', 1, '2026-11-17'))
                conn.commit()
            replies = [{'facts': [fact('太郎', '学生', '太郎は学生。')]}, {'items': [{'index': 0, 'person': True, 'same': -1}]}]
            with patch.object(notes.llm, 'chat', side_effect=[json.dumps(r) for r in replies]):
                notes.run(root, 'sample', 'unused')
            self.assertTrue((folder / 'notes' / 'people.json').is_file())
            app = FastAPI()
            app.include_router(router)
            client = TestClient(app)
            query = {'root': str(root), 'page': 0}
            response = client.get('/works/sample/notes', params=query)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['people'][0]['name'], '太郎')
            self.assertEqual(response.json()['checked'], 1)
            self.assertEqual(response.json()['untidy'], 0)
            self.assertEqual(client.patch('/works/sample/notes', json={'root': str(root), 'spoiler_guard': False}).status_code, 200)
            self.assertFalse(client.get('/works/sample/notes', params=query).json()['spoiler_guard'])


if __name__ == '__main__':
    unittest.main()
