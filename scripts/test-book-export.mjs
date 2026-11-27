import assert from 'node:assert/strict'
import test from 'node:test'
import { exportFileName, bookStoredRelPath } from '../src/services/bookExport.ts'

test('exportFileName uses sanitized book title and preserves original extension', () => {
  assert.equal(
    exportFileName({
      title: '[汐乃コウ] 営業先の裕子さん',
      fileName: '15e3829c-5881-4f23-86f2-cfa7f58d6.cbz',
      format: 'cbz',
    }),
    '[汐乃コウ] 営業先の裕子さん.cbz',
  )

  assert.equal(
    exportFileName({
      title: 'Test: Comic / Vol*1? "Special" <1>',
      fileName: 'abc.cbz',
      format: 'cbz',
    }),
    'Test_ Comic _ Vol_1_ _Special_ _1_.cbz',
  )

  assert.equal(
    exportFileName({
      title: '已经带后缀的漫画.cbz',
      fileName: 'raw.cbz',
      format: 'cbz',
    }),
    '已经带后缀的漫画.cbz',
  )

  assert.equal(
    exportFileName({
      title: '   ',
      fileName: 'book.epub',
      format: 'epub',
    }),
    'book.epub',
  )
})

test('bookStoredRelPath matches TauriStorage bookPath convention', () => {
  assert.equal(
    bookStoredRelPath({ id: 'uuid-1', fileName: 'test.cbz', format: 'cbz' }),
    'books/uuid-1.cbz',
  )
  assert.equal(
    bookStoredRelPath({ id: 'uuid-2', fileName: 'novel.fb2.zip', format: 'fb2' }),
    'books/uuid-2.fb2.zip',
  )
})
