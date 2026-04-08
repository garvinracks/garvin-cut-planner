'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import { buildCutLists, type SheetResultRow, type TubeResultRow } from '@/lib/planner'
import { downloadXlsx } from '@/lib/xlsx'
import DxfPartPreview from '@/components/DxfPartPreview'

type SKU = {
  id: string
  description: string
}

type PlannerRow = {
  skuId: string
  qty: string
  skuLookup: string
}

type PartRecord = {
  id: string
  part_number: string
  description: string
  part_type: 'tube' | 'sheet'
  material: string | null
  thickness: string | null
  tube_od: string | null
  tube_wall: string | null
  cut_length: number | null
  dxf_file: string | null
}

type SkuPartRecord = {
  sku_id: string
  part_id: string
  qty: number
}

type SkuSubAssemblyRecord = {
  sku_id: string
  sub_assembly_id: string
  qty: number
}

type SubAssemblyPartRecord = {
  sub_assembly_id: string
  part_id: string
  qty: number
}

type GroupedTubeSection = {
  key: string
  material: string
  tube_od: string
  tube_wall: string
  rows: TubeResultRow[]
  totalQty: number
  totalLength: number
}

type GroupedSheetSection = {
  key: string
  material: string
  thickness: string
  rows: SheetResultRow[]
  totalQty: number
}

export default function PlannerPage() {
  const supabase = useMemo(() => createBrowserClient(), [])

  const [skus, setSkus] = useState<SKU[]>([])
  const [parts, setParts] = useState<PartRecord[]>([])
  const [skuParts, setSkuParts] = useState<SkuPartRecord[]>([])
  const [skuSubAssemblies, setSkuSubAssemblies] = useState<SkuSubAssemblyRecord[]>([])
  const [subAssemblyParts, setSubAssemblyParts] = useState<SubAssemblyPartRecord[]>([])

  const [rows, setRows] = useState<PlannerRow[]>([
    { skuId: '', qty: '', skuLookup: '' },
    { skuId: '', qty: '', skuLookup: '' },
    { skuId: '', qty: '', skuLookup: '' },
  ])

  const [tubeRows, setTubeRows] = useState<TubeResultRow[]>([])
  const [sheetRows, setSheetRows] = useState<SheetResultRow[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [printedAt, setPrintedAt] = useState('')

  useEffect(() => {
    setPrintedAt(new Date().toLocaleString())
  }, [])

  async function loadData() {
    setLoading(true)
    setMessage('')

    const [
      { data: skuData, error: skuError },
      { data: partData, error: partError },
      { data: skuPartData, error: skuPartError },
      { data: skuSubData, error: skuSubError },
      { data: subPartData, error: subPartError },
    ] = await Promise.all([
      supabase.from('skus').select('id, description').order('id', { ascending: true }),
      supabase
        .from('parts')
        .select('id, part_number, description, part_type, material, thickness, tube_od, tube_wall, cut_length, dxf_file'),
      supabase.from('sku_parts').select('sku_id, part_id, qty'),
      supabase.from('sku_sub_assemblies').select('sku_id, sub_assembly_id, qty'),
      supabase.from('sub_assembly_parts').select('sub_assembly_id, part_id, qty'),
    ])

    if (skuError || partError || skuPartError || skuSubError || subPartError) {
      setMessage(
        skuError?.message ||
          partError?.message ||
          skuPartError?.message ||
          skuSubError?.message ||
          subPartError?.message ||
          'Load failed'
      )
      setLoading(false)
      return
    }

    setSkus((skuData ?? []) as SKU[])
    setParts((partData ?? []) as PartRecord[])
    setSkuParts((skuPartData ?? []) as SkuPartRecord[])
    setSkuSubAssemblies((skuSubData ?? []) as SkuSubAssemblyRecord[])
    setSubAssemblyParts((subPartData ?? []) as SubAssemblyPartRecord[])

    setLoading(false)
  }

  useEffect(() => {
    void loadData()
  }, [])

  function findSkuByLookup(value: string) {
    const q = value.trim().toLowerCase()
    if (!q) return null

    return (
      skus.find(
        (sku) =>
          sku.id.toLowerCase() === q ||
          sku.description.toLowerCase() === q ||
          `${sku.id} — ${sku.description}`.toLowerCase() === q
      ) ?? null
    )
  }

  function updateRow(index: number, field: 'skuId' | 'qty' | 'skuLookup', value: string) {
    setRows((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row

        if (field === 'skuLookup') {
          const match = findSkuByLookup(value)
          return {
            ...row,
            skuLookup: value,
            skuId: match?.id || '',
          }
        }

        return { ...row, [field]: value }
      })
    )
  }

  function addRow() {
    setRows((prev) => [...prev, { skuId: '', qty: '', skuLookup: '' }])
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index))
  }

  function buildWarnings(plannerRows: Array<{ skuId: string; qty: number }>) {
    const nextWarnings: string[] = []
    const partMap = new Map(parts.map((part) => [part.id, part]))

    for (const row of plannerRows) {
      const directParts = skuParts.filter((sp) => sp.sku_id === row.skuId)
      const linkedSubAssemblies = skuSubAssemblies.filter((ssa) => ssa.sku_id === row.skuId)

      if (directParts.length === 0 && linkedSubAssemblies.length === 0) {
        nextWarnings.push(`${row.skuId}: SKU has no direct parts or subassemblies.`)
      }

      for (const direct of directParts) {
        const part = partMap.get(direct.part_id)
        if (!part) {
          nextWarnings.push(`${row.skuId}: Missing direct part ${direct.part_id}.`)
          continue
        }

        if (part.part_type === 'tube' && (!part.cut_length || part.cut_length <= 0)) {
          nextWarnings.push(`${row.skuId}: Tube part ${part.part_number} is missing cut length.`)
        }

        if (part.part_type === 'sheet' && !part.dxf_file) {
          nextWarnings.push(`${row.skuId}: Sheet part ${part.part_number} is missing DXF file path.`)
        }

        if (part.part_type === 'tube' && (!part.tube_od || !part.tube_wall || !part.material)) {
          nextWarnings.push(`${row.skuId}: Tube part ${part.part_number} is missing material data.`)
        }

        if (part.part_type === 'sheet' && (!part.thickness || !part.material)) {
          nextWarnings.push(`${row.skuId}: Sheet part ${part.part_number} is missing material data.`)
        }
      }

      for (const linked of linkedSubAssemblies) {
        const subParts = subAssemblyParts.filter((sap) => sap.sub_assembly_id === linked.sub_assembly_id)

        if (subParts.length === 0) {
          nextWarnings.push(`${row.skuId}: Subassembly ${linked.sub_assembly_id} has no parts.`)
        }

        for (const subPart of subParts) {
          const part = partMap.get(subPart.part_id)
          if (!part) {
            nextWarnings.push(`${row.skuId}: Missing part ${subPart.part_id} in subassembly ${linked.sub_assembly_id}.`)
            continue
          }

          if (part.part_type === 'tube' && (!part.cut_length || part.cut_length <= 0)) {
            nextWarnings.push(`${row.skuId}: Tube part ${part.part_number} is missing cut length.`)
          }

          if (part.part_type === 'sheet' && !part.dxf_file) {
            nextWarnings.push(`${row.skuId}: Sheet part ${part.part_number} is missing DXF file path.`)
          }

          if (part.part_type === 'tube' && (!part.tube_od || !part.tube_wall || !part.material)) {
            nextWarnings.push(`${row.skuId}: Tube part ${part.part_number} is missing material data.`)
          }

          if (part.part_type === 'sheet' && (!part.thickness || !part.material)) {
            nextWarnings.push(`${row.skuId}: Sheet part ${part.part_number} is missing material data.`)
          }
        }
      }
    }

    setWarnings(Array.from(new Set(nextWarnings)))
  }

  function handleGenerate() {
    const plannerRows = rows
      .map((row) => ({
        skuId: row.skuId,
        qty: Number(row.qty),
      }))
      .filter((row) => row.skuId && row.qty > 0)

    if (plannerRows.length === 0) {
      setMessage('Enter at least one SKU with a qty greater than 0.')
      setTubeRows([])
      setSheetRows([])
      setWarnings([])
      return
    }

    const result = buildCutLists({
      plannerRows,
      parts,
      skuParts,
      skuSubAssemblies,
      subAssemblyParts,
    })

    setTubeRows(result.tubeRows)
    setSheetRows(result.sheetRows)
    setMessage('')
    buildWarnings(plannerRows)
  }

  const groupedTubeSections = useMemo<GroupedTubeSection[]>(() => {
    const map = new Map<string, GroupedTubeSection>()

    for (const row of tubeRows) {
      const key = `${row.material}__${row.tube_od}__${row.tube_wall}`
      const existing = map.get(key)

      if (existing) {
        existing.rows.push(row)
        existing.totalQty += row.qty
        existing.totalLength += row.total_length
      } else {
        map.set(key, {
          key,
          material: row.material,
          tube_od: row.tube_od,
          tube_wall: row.tube_wall,
          rows: [row],
          totalQty: row.qty,
          totalLength: row.total_length,
        })
      }
    }

    return Array.from(map.values())
  }, [tubeRows])

  const groupedSheetSections = useMemo<GroupedSheetSection[]>(() => {
    const map = new Map<string, GroupedSheetSection>()

    for (const row of sheetRows) {
      const key = `${row.material}__${row.thickness}`
      const existing = map.get(key)

      if (existing) {
        existing.rows.push(row)
        existing.totalQty += row.qty
      } else {
        map.set(key, {
          key,
          material: row.material,
          thickness: row.thickness,
          rows: [row],
          totalQty: row.qty,
        })
      }
    }

    return Array.from(map.values())
  }, [sheetRows])

  function exportTubeXlsx() {
    if (tubeRows.length === 0) return

    downloadXlsx(
      'tube-cut-list.xlsx',
      'TubeCutList',
      tubeRows.map((row) => ({
        material: row.material,
        tube_od: row.tube_od,
        tube_wall: row.tube_wall,
        part_number: row.part_number,
        description: row.description,
        qty: row.qty,
        cut_length: row.cut_length,
        total_length: row.total_length,
      }))
    )
  }

  function exportCypCutXlsx() {
    if (sheetRows.length === 0) return

    downloadXlsx(
      'cypcut-sheet-import.xlsx',
      'PartsDefinition',
      sheetRows.map((row) => ({
        PartName: row.part_number,
        Amount: Math.ceil(row.qty * 1.05),
        FilePath: row.dxf_file || '',
      }))
    )
  }

  function handlePrint() {
    window.print()
  }

  return (
    <div className="section-stack">
      <div className="print-only" style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0 }}>Garvin Cut Planner</h1>
        <div style={{ color: '#555', marginTop: 4 }}>Printed on {printedAt || ''}</div>
      </div>

      <div className="page-header no-print">
        <div>
          <div className="kicker">Garvin Internal Tool</div>
          <h1 className="page-title">Build Planner</h1>
          <div className="page-subtitle">
            Enter SKU quantities and generate tube lists plus a CypCut-ready Excel import file.
          </div>
        </div>
      </div>

      <div className="grid-2 no-print">
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Build Input</h2>
            <div className="card-subtitle">
              Type SKU numbers instead of scrolling long dropdown lists.
            </div>
          </div>
          <div className="card-body">
            {loading ? (
              <div className="empty">Loading...</div>
            ) : (
              <>
                {rows.map((row, index) => (
                  <div key={index} className="field-grid">
                    <div>
                      <input
                        className="field"
                        list={`planner-sku-list-${index}`}
                        value={row.skuLookup}
                        onChange={(e) => updateRow(index, 'skuLookup', e.target.value)}
                        placeholder="Type SKU number or description"
                      />
                      <datalist id={`planner-sku-list-${index}`}>
                        {skus.map((sku) => (
                          <option key={sku.id} value={sku.id}>
                            {sku.description}
                          </option>
                        ))}
                      </datalist>
                    </div>

                    <input
                      className="field"
                      value={row.qty}
                      onChange={(e) => updateRow(index, 'qty', e.target.value)}
                      placeholder="Qty"
                    />

                    <button type="button" onClick={() => removeRow(index)} className="btn btn-danger">
                      Remove
                    </button>
                  </div>
                ))}

                <div className="btn-row" style={{ marginTop: 14 }}>
                  <button type="button" onClick={addRow} className="btn btn-secondary">
                    Add Row
                  </button>
                  <button type="button" onClick={handleGenerate} className="btn btn-primary">
                    Generate Cut Lists
                  </button>
                </div>

                {message && <div className="message">{message}</div>}
              </>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Exports</h2>
            <div className="card-subtitle">
              Export tubes normally and sheets in CypCut Excel format.
            </div>
          </div>
          <div className="card-body">
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={exportTubeXlsx}
                disabled={tubeRows.length === 0}
              >
                Export Tube XLSX
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={exportCypCutXlsx}
                disabled={sheetRows.length === 0}
              >
                Export CypCut XLSX
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handlePrint}
                disabled={tubeRows.length === 0 && sheetRows.length === 0}
              >
                Print
              </button>
            </div>

            <div style={{ marginTop: 14, color: 'var(--muted)', fontSize: '0.92rem' }}>
              CypCut Excel columns: <strong>PartName</strong>, <strong>Amount</strong>, <strong>FilePath</strong>
            </div>
          </div>
        </section>
      </div>

      {warnings.length > 0 && (
        <section className="warning-box">
          <strong>Warnings</strong>
          <ul className="warning-list">
            {warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Tube Cut List</h2>
          <div className="card-subtitle">
            Grouped by material, tube OD, and wall.
          </div>
        </div>
        <div className="card-body">
          {groupedTubeSections.length === 0 ? (
            <div className="empty">No tube results yet.</div>
          ) : (
            <div className="section-stack">
              {groupedTubeSections.map((section) => (
                <div key={section.key}>
                  <div className="group-title">
                    {section.material || 'Unspecified material'} / {section.tube_od || 'No OD'} x {section.tube_wall || 'No wall'}
                  </div>
                  <div className="result-summary">
                    <div className="pill">
                      Total qty: <strong>{section.totalQty}</strong>
                    </div>
                    <div className="pill">
                      Total length (in): <strong>{section.totalLength}</strong>
                    </div>
                    <div className="pill">
                      Total length (ft): <strong>{(section.totalLength / 12).toFixed(2)}</strong>
                    </div>
                  </div>

                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Part #</th>
                          <th>Description</th>
                          <th>Qty</th>
                          <th>Cut Length</th>
                          <th>Total Length</th>
                        </tr>
                      </thead>
                      <tbody>
                        {section.rows.map((row) => (
                          <tr key={`${section.key}-${row.part_number}`}>
                            <td>{row.part_number}</td>
                            <td>{row.description}</td>
                            <td>{row.qty}</td>
                            <td>{row.cut_length}</td>
                            <td>{row.total_length}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Sheet Cut List</h2>
          <div className="card-subtitle">
            Grouped by material and thickness. Export button makes the CypCut Excel import file.
          </div>
        </div>
        <div className="card-body">
          {groupedSheetSections.length === 0 ? (
            <div className="empty">No sheet results yet.</div>
          ) : (
            <div className="section-stack">
              {groupedSheetSections.map((section) => (
                <div key={section.key}>
                  <div className="group-title">
                    {section.material || 'Unspecified material'} / {section.thickness || 'No thickness'}
                  </div>
                  <div className="result-summary">
                    <div className="pill">
                      Total qty: <strong>{section.totalQty}</strong>
                    </div>
                    <div className="pill">
                      Parts: <strong>{section.rows.length}</strong>
                    </div>
                  </div>

                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th style={{ width: 120 }}>Preview</th>
                          <th>Part #</th>
                          <th>Description</th>
                          <th>Qty</th>
                          <th>DXF File</th>
                        </tr>
                      </thead>
                      <tbody>
                        {section.rows.map((row) => (
                          <tr key={`${section.key}-${row.part_number}`}>
                            <td>
                              <DxfPartPreview
                                dxfFile={row.dxf_file || null}
                                partNumber={row.part_number}
                                size="tiny"
                              />
                            </td>
                            <td>{row.part_number}</td>
                            <td>{row.description}</td>
                            <td>{row.qty}</td>
                            <td>{row.dxf_file || ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}