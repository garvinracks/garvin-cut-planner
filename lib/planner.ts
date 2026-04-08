type PlannerInputRow = {
  skuId: string
  qty: number
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

export type TubeResultRow = {
  material: string
  tube_od: string
  tube_wall: string
  part_number: string
  description: string
  qty: number
  cut_length: number
  total_length: number
}

export type SheetResultRow = {
  material: string
  thickness: string
  part_number: string
  description: string
  qty: number
  dxf_file: string | null
}

export type PlannerResult = {
  tubeRows: TubeResultRow[]
  sheetRows: SheetResultRow[]
}

export function buildCutLists(args: {
  plannerRows: PlannerInputRow[]
  parts: PartRecord[]
  skuParts: SkuPartRecord[]
  skuSubAssemblies: SkuSubAssemblyRecord[]
  subAssemblyParts: SubAssemblyPartRecord[]
}): PlannerResult {
  const { plannerRows, parts, skuParts, skuSubAssemblies, subAssemblyParts } = args

  const partMap = new Map(parts.map((part) => [part.id, part]))
  const totals = new Map<string, number>()

  function addPartQty(partId: string, qtyToAdd: number) {
    const current = totals.get(partId) || 0
    totals.set(partId, current + qtyToAdd)
  }

  for (const row of plannerRows) {
    if (!row.skuId || !row.qty || row.qty <= 0) continue

    const directParts = skuParts.filter((sp) => sp.sku_id === row.skuId)
    for (const direct of directParts) {
      addPartQty(direct.part_id, row.qty * Number(direct.qty))
    }

    const linkedSubAssemblies = skuSubAssemblies.filter((ssa) => ssa.sku_id === row.skuId)
    for (const linked of linkedSubAssemblies) {
      const subParts = subAssemblyParts.filter((sap) => sap.sub_assembly_id === linked.sub_assembly_id)
      for (const subPart of subParts) {
        addPartQty(subPart.part_id, row.qty * Number(linked.qty) * Number(subPart.qty))
      }
    }
  }

  const tubeRows: TubeResultRow[] = []
  const sheetRows: SheetResultRow[] = []

  for (const [partId, qty] of totals.entries()) {
    const part = partMap.get(partId)
    if (!part) continue

    if (part.part_type === 'tube') {
      tubeRows.push({
        material: part.material || '',
        tube_od: part.tube_od || '',
        tube_wall: part.tube_wall || '',
        part_number: part.part_number,
        description: part.description,
        qty,
        cut_length: part.cut_length || 0,
        total_length: qty * (part.cut_length || 0),
      })
    }

    if (part.part_type === 'sheet') {
      sheetRows.push({
        material: part.material || '',
        thickness: part.thickness || '',
        part_number: part.part_number,
        description: part.description,
        qty,
        dxf_file: part.dxf_file || null,
      })
    }
  }

  tubeRows.sort((a, b) => {
    if (a.material !== b.material) return a.material.localeCompare(b.material)
    if (a.tube_od !== b.tube_od) return a.tube_od.localeCompare(b.tube_od, undefined, { numeric: true })
    if (a.tube_wall !== b.tube_wall) return a.tube_wall.localeCompare(b.tube_wall, undefined, { numeric: true })
    return a.part_number.localeCompare(b.part_number, undefined, { numeric: true })
  })

  sheetRows.sort((a, b) => {
    if (a.material !== b.material) return a.material.localeCompare(b.material)
    if (a.thickness !== b.thickness) return a.thickness.localeCompare(b.thickness, undefined, { numeric: true })
    return a.part_number.localeCompare(b.part_number, undefined, { numeric: true })
  })

  return {
    tubeRows,
    sheetRows,
  }
}