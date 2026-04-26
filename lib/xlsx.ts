import * as XLSX from 'xlsx'

export function downloadXlsx(
  fileName: string,
  sheetName: string,
  rows: Array<Record<string, string | number | null | undefined>>
) {
  const worksheet = XLSX.utils.json_to_sheet(rows)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName)
  XLSX.writeFile(workbook, fileName)
}

/** Returns the workbook as a Uint8Array buffer (for embedding in a ZIP, etc.) */
export function xlsxToBuffer(
  sheetName: string,
  rows: Array<Record<string, string | number | null | undefined>>
): Uint8Array {
  const worksheet = XLSX.utils.json_to_sheet(rows)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName)
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })
}