import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearSourceSession,
  getSourceSession,
  saveSourceSession,
} from '../src/services/comicPlugin/sourceSession.ts'

test('saveSourceSession and getSourceSession preserve search/browse/scroll context per plugin uuid', () => {
  clearSourceSession('p1')
  saveSourceSession('p1', {
    detailOrigin: 'search',
    keyword: '海贼',
    page: 3,
    items: [{ id: 'c1', title: 'One Piece', cover: '' }],
    paging: { page: 3, pages: 10 },
    viewScrollTop: { browse: 420, search: 980 },
  })
  const snap = getSourceSession('p1')
  assert.ok(snap)
  assert.equal(snap.detailOrigin, 'search')
  assert.equal(snap.keyword, '海贼')
  assert.equal(snap.page, 3)
  assert.equal(snap.items.length, 1)
  assert.equal(snap.viewScrollTop.browse, 420)
  assert.equal(snap.viewScrollTop.search, 980)
})

test('clearSourceSession removes only the target plugin session', () => {
  saveSourceSession('p1', { keyword: 'a' })
  saveSourceSession('p2', { keyword: 'b' })
  clearSourceSession('p1')
  assert.equal(getSourceSession('p1'), undefined)
  assert.equal(getSourceSession('p2')?.keyword, 'b')
  clearSourceSession('p2')
})
