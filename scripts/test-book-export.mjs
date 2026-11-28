import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  assert.equal(
    exportFileName({
      title: 'CON',
      fileName: 'raw.cbz',
      format: 'cbz',
    }),
    '_CON.cbz',
  )

  assert.equal(
    exportFileName({
      title: 'con.cbz',
      fileName: 'raw.cbz',
      format: 'cbz',
    }),
    '_con.cbz',
  )

  assert.equal(
    exportFileName({
      title: 'AUX.fb2.zip',
      fileName: 'raw.fb2.zip',
      format: 'fb2',
    }),
    '_AUX.fb2.zip',
  )

  assert.equal(
    exportFileName({
      title: 'COM¹',
      fileName: 'raw.cbz',
      format: 'cbz',
    }),
    '_COM¹.cbz',
  )

  assert.equal(
    exportFileName({
      title: 'lpt².cbz',
      fileName: 'raw.cbz',
      format: 'cbz',
    }),
    '_lpt².cbz',
  )

  assert.equal(
    exportFileName({
      title: 'COM³.fb2.zip',
      fileName: 'raw.fb2.zip',
      format: 'fb2',
    }),
    '_COM³.fb2.zip',
  )

  assert.equal(
    exportFileName({
      title: 'CON .cbz',
      fileName: 'raw.cbz',
      format: 'cbz',
    }),
    '_CON .cbz',
  )

  assert.equal(
    exportFileName({
      title: 'COM¹ .cbz',
      fileName: 'raw.cbz',
      format: 'cbz',
    }),
    '_COM¹ .cbz',
  )

  assert.equal(
    exportFileName({
      title: 'lpt² .fb2.zip',
      fileName: 'raw.fb2.zip',
      format: 'fb2',
    }),
    '_lpt² .fb2.zip',
  )

  // 在当前平台（Windows）真实落盘验证带空格保留名转换后可创建普通文件且内容完整
  const dir = mkdtempSync(join(tmpdir(), 'lrx-export-name-'))
  try {
    const safeName = exportFileName({ title: 'CON .cbz', fileName: 'raw.cbz', format: 'cbz' })
    assert.equal(safeName, '_CON .cbz')
    const outPath = join(dir, safeName)
    writeFileSync(outPath, 'cbz-payload')
    assert.equal(statSync(outPath).isFile(), true)
    assert.equal(readFileSync(outPath, 'utf8'), 'cbz-payload')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  assert.equal(
    exportFileName({
      title: '红楼梦',
      fileName: 'uuid.epub',
      format: 'epub',
    }),
    '红楼梦.epub',
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
