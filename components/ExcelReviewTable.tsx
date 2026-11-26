"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, RotateCcw } from "lucide-react";

export type RowHeightMode = "compact" | "standard" | "tall" | "autofit";

export type ExcelColumnDef<T> = {
  id: string;
  label: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  sortable?: boolean;
  sortValue?: (row: T) => string | number;
  renderCell: (row: T, rowIndex: number) => React.ReactNode;
};

type SortState = {
  colId: string;
  dir: "asc" | "desc";
} | null;

const ROW_PRESET_HEIGHTS: Record<Exclude<RowHeightMode, "autofit">, number> = {
  compact: 38,
  standard: 46,
  tall: 92,
};

function readStorageJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export default function ExcelReviewTable<T>({
  rows,
  columns,
  rowKey,
  storageKey = "support_tickets",
  defaultRowHeight = 46,
  defaultRowHeightMode = "autofit",
  onRowClick,
  isRowSelected,
  toolbarExtra,
}: {
  rows: T[];
  columns: ExcelColumnDef<T>[];
  rowKey: (row: T) => string;
  storageKey?: string;
  defaultRowHeight?: number;
  defaultRowHeightMode?: RowHeightMode;
  onRowClick?: (row: T) => void;
  isRowSelected?: (row: T) => boolean;
  toolbarExtra?: React.ReactNode;
}) {
  const defaultWidths = useMemo(() => {
    const map: Record<string, number> = {};
    for (const col of columns) {
      map[col.id] = col.defaultWidth ?? 160;
    }
    return map;
  }, [columns]);

  const keys = useMemo(
    () => ({
      cols: `excel_cols_${storageKey}`,
      baseH: `excel_base_h_${storageKey}`,
      rowM: `excel_row_m_${storageKey}`,
      rowHeights: `excel_row_heights_${storageKey}`,
      sort: `excel_sort_${storageKey}`,
    }),
    [storageKey],
  );

  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    const saved = readStorageJson<Record<string, number>>(keys.cols, {});
    return { ...defaultWidths, ...saved };
  });
  const [baseRowHeight, setBaseRowHeight] = useState<number>(() => {
    if (typeof window === "undefined") return defaultRowHeight;
    const saved = Number(window.localStorage.getItem(keys.baseH));
    return Number.isFinite(saved) && saved >= 34 ? saved : defaultRowHeight;
  });
  const [rowHeightMode, setRowHeightMode] = useState<RowHeightMode>(() => {
    if (typeof window === "undefined") return defaultRowHeightMode;
    const saved = window.localStorage.getItem(keys.rowM);
    if (
      saved === "compact" ||
      saved === "standard" ||
      saved === "tall" ||
      saved === "autofit"
    ) {
      return saved;
    }
    return defaultRowHeightMode;
  });
  const [rowHeights, setRowHeights] = useState<Record<number, number>>(() =>
    readStorageJson<Record<number, number>>(keys.rowHeights, {}),
  );
  const [sortState, setSortState] = useState<SortState>(() =>
    readStorageJson<SortState>(keys.sort, null),
  );
  const [activeDragCol, setActiveDragCol] = useState<string | null>(null);

  const colWidthsRef = useRef(colWidths);
  const rowHeightsRef = useRef(rowHeights);

  useEffect(() => {
    colWidthsRef.current = { ...defaultWidths, ...colWidths };
  }, [defaultWidths, colWidths]);

  useEffect(() => {
    rowHeightsRef.current = rowHeights;
  }, [rowHeights]);

  const resizingCol = useRef<{
    colId: string;
    startX: number;
    startWidth: number;
    minW: number;
    maxW: number;
  } | null>(null);

  const resizingRow = useRef<{
    rowIndex: number;
    startY: number;
    startHeight: number;
  } | null>(null);

  const mergedColWidths = useMemo(
    () => ({ ...defaultWidths, ...colWidths }),
    [defaultWidths, colWidths],
  );

  const sortedRows = useMemo(() => {
    if (!sortState) return rows;
    const col = columns.find((c) => c.id === sortState.colId);
    if (!col?.sortValue) return rows;
    const factor = sortState.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = col.sortValue!(a);
      const vb = col.sortValue!(b);
      if (typeof va === "number" && typeof vb === "number") {
        return (va - vb) * factor;
      }
      return String(va).localeCompare(String(vb)) * factor;
    });
  }, [rows, columns, sortState]);

  const totalTableWidth = useMemo(
    () =>
      columns.reduce(
        (acc, col) => acc + (mergedColWidths[col.id] ?? col.defaultWidth ?? 160),
        44,
      ),
    [columns, mergedColWidths],
  );

  function selectDensityMode(mode: RowHeightMode) {
    setRowHeightMode(mode);
    setRowHeights({});
    if (mode !== "autofit") {
      const nextBase = mode === "standard" ? defaultRowHeight : ROW_PRESET_HEIGHTS[mode];
      setBaseRowHeight(nextBase);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(keys.baseH, String(nextBase));
      }
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem(keys.rowM, mode);
      window.localStorage.removeItem(keys.rowHeights);
    }
  }

  function toggleSort(col: ExcelColumnDef<T>) {
    if (!col.sortable || !col.sortValue) return;
    setSortState((prev) => {
      let next: SortState;
      if (!prev || prev.colId !== col.id) {
        next = { colId: col.id, dir: "asc" };
      } else if (prev.dir === "asc") {
        next = { colId: col.id, dir: "desc" };
      } else {
        next = null;
      }
      if (typeof window !== "undefined") {
        if (next) window.localStorage.setItem(keys.sort, JSON.stringify(next));
        else window.localStorage.removeItem(keys.sort);
      }
      return next;
    });
  }

  function startColResize(e: React.MouseEvent, col: ExcelColumnDef<T>) {
    e.preventDefault();
    e.stopPropagation();
    const startWidth = mergedColWidths[col.id] ?? col.defaultWidth ?? 160;
    const minW = col.minWidth ?? 35;
    const maxW = col.maxWidth ?? 1600;
    resizingCol.current = { colId: col.id, startX: e.clientX, startWidth, minW, maxW };
    setActiveDragCol(col.id);

    const onMouseMove = (ev: MouseEvent) => {
      const drag = resizingCol.current;
      if (!drag) return;
      const delta = ev.clientX - drag.startX;
      const newWidth = Math.min(drag.maxW, Math.max(drag.minW, drag.startWidth + delta));
      setColWidths((prev) => ({ ...prev, [drag.colId]: newWidth }));
    };

    const onMouseUp = () => {
      resizingCol.current = null;
      setActiveDragCol(null);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(keys.cols, JSON.stringify(colWidthsRef.current));
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  function resetSingleColumn(e: React.MouseEvent, col: ExcelColumnDef<T>) {
    e.preventDefault();
    e.stopPropagation();
    const fallbackW = col.defaultWidth ?? 160;
    setColWidths((prev) => {
      const next = { ...prev, [col.id]: fallbackW };
      if (typeof window !== "undefined") {
        window.localStorage.setItem(keys.cols, JSON.stringify(next));
      }
      return next;
    });
  }

  function startRowResize(e: React.MouseEvent<HTMLElement>, rowIndex: number) {
    e.preventDefault();
    e.stopPropagation();
    const rowElement = e.currentTarget.closest("tr");
    const startHeight =
      rowElement?.offsetHeight ?? rowHeights[rowIndex] ?? baseRowHeight;
    resizingRow.current = { rowIndex, startY: e.clientY, startHeight };

    const onMouseMove = (ev: MouseEvent) => {
      const drag = resizingRow.current;
      if (!drag) return;
      const delta = ev.clientY - drag.startY;
      const newHeight = Math.max(34, Math.min(1000, drag.startHeight + delta));
      setRowHeightMode("standard");
      setRowHeights((prev) => ({ ...prev, [drag.rowIndex]: newHeight }));
    };

    const onMouseUp = () => {
      resizingRow.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(keys.rowM, "standard");
        window.localStorage.setItem(
          keys.rowHeights,
          JSON.stringify(rowHeightsRef.current),
        );
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  function resetSingleRow(e: React.MouseEvent, rowIndex: number) {
    e.preventDefault();
    e.stopPropagation();
    setRowHeights((prev) => {
      const next = { ...prev };
      delete next[rowIndex];
      if (typeof window !== "undefined") {
        window.localStorage.setItem(keys.rowHeights, JSON.stringify(next));
      }
      return next;
    });
  }

  function handleResetAll() {
    setColWidths(defaultWidths);
    setRowHeights({});
    setBaseRowHeight(defaultRowHeight);
    setRowHeightMode("standard");
    setSortState(null);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(keys.cols);
      window.localStorage.removeItem(keys.baseH);
      window.localStorage.removeItem(keys.rowM);
      window.localStorage.removeItem(keys.rowHeights);
      window.localStorage.removeItem(keys.sort);
    }
  }

  const modeButtons: Array<{ key: RowHeightMode; label: string }> = [
    { key: "compact", label: "Compact" },
    { key: "standard", label: "Standard" },
    { key: "tall", label: "Tall" },
    { key: "autofit", label: "Auto-fit" },
  ];

  return (
    <div className="panel overflow-hidden flex flex-col">
      {/* Toolbar: Density Modes + Reset */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mr-1">
            Row View:
          </span>
          {modeButtons.map((btn) => (
            <button
              key={btn.key}
              type="button"
              onClick={() => selectDensityMode(btn.key)}
              className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition cursor-pointer ${
                rowHeightMode === btn.key
                  ? "border-primary bg-primary text-primary-foreground shadow-xs"
                  : "border-border bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {btn.label}
            </button>
          ))}
          <button
            type="button"
            onClick={handleResetAll}
            title="Reset column widths, row heights, and sorting"
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground transition cursor-pointer ml-1"
          >
            <RotateCcw size={11} /> Reset
          </button>
        </div>
        {toolbarExtra && <div className="flex flex-wrap items-center gap-2">{toolbarExtra}</div>}
      </div>

      {/* Scrollable Viewport Wrapper */}
      <div className="max-h-[75vh] overflow-x-auto overflow-y-auto relative">
        <table
          className="table-fixed border-collapse w-full text-left text-xs"
          style={{ minWidth: `${totalTableWidth}px` }}
        >
          <colgroup>
            <col style={{ width: "44px" }} />
            {columns.map((col) => {
              const colW = mergedColWidths[col.id] ?? col.defaultWidth ?? 160;
              return <col key={col.id} style={{ width: `${colW}px` }} />;
            })}
          </colgroup>

          <thead>
            <tr className="sticky top-0 z-20 bg-muted/95 backdrop-blur border-b border-border text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              <th
                className="sticky left-0 z-30 border-r border-border bg-muted/95 px-2 py-2.5 text-center font-mono select-none"
                style={{ width: "44px", minWidth: "44px", maxWidth: "44px" }}
              >
                #
              </th>
              {columns.map((col) => {
                const colW = mergedColWidths[col.id] ?? col.defaultWidth ?? 160;
                const isSorted = sortState?.colId === col.id ? sortState.dir : null;
                return (
                  <th
                    key={col.id}
                    style={{
                      width: `${colW}px`,
                      minWidth: `${colW}px`,
                      maxWidth: `${colW}px`,
                    }}
                    className="relative border-r border-border/70 px-3 py-2.5 align-middle select-none"
                  >
                    {col.sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(col)}
                        className="flex w-full items-center justify-between gap-1.5 pr-2 truncate text-left uppercase tracking-wider hover:text-foreground cursor-pointer"
                      >
                        <span className="truncate">{col.label}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {isSorted === "asc" ? (
                            <ArrowUp size={12} className="text-primary" />
                          ) : isSorted === "desc" ? (
                            <ArrowDown size={12} className="text-primary" />
                          ) : (
                            <ArrowUpDown size={11} className="opacity-50" />
                          )}
                        </span>
                      </button>
                    ) : (
                      <div className="flex items-center justify-between gap-1.5 pr-2 truncate">
                        <span className="truncate">{col.label}</span>
                      </div>
                    )}
                    {/* Column Resize Handle */}
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={`Resize ${col.label} column`}
                      title="Drag to resize column (double-click to reset)"
                      onMouseDown={(e) => startColResize(e, col)}
                      onDoubleClick={(e) => resetSingleColumn(e, col)}
                      className={`absolute right-0 top-0 bottom-0 z-20 w-2.5 cursor-col-resize transition-colors ${
                        activeDragCol === col.id
                          ? "bg-primary/50"
                          : "hover:bg-primary/35"
                      }`}
                    />
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody className="divide-y divide-border">
            {sortedRows.map((row, rowIndex) => {
              const key = rowKey(row);
              const selected = isRowSelected ? isRowSelected(row) : false;
              const explicitRowH = rowHeights[rowIndex];
              const thisRowHeight =
                rowHeightMode === "autofit"
                  ? undefined
                  : explicitRowH ??
                    (rowHeightMode === "compact"
                      ? ROW_PRESET_HEIGHTS.compact
                      : rowHeightMode === "tall"
                        ? ROW_PRESET_HEIGHTS.tall
                        : baseRowHeight);

              const trStyle: React.CSSProperties | undefined =
                thisRowHeight !== undefined
                  ? { height: `${thisRowHeight}px`, maxHeight: `${thisRowHeight}px` }
                  : undefined;

              const innerMaxH =
                rowHeightMode !== "autofit" && thisRowHeight !== undefined
                  ? { maxHeight: `${Math.max(20, thisRowHeight - 12)}px` }
                  : undefined;

              return (
                <tr
                  key={key}
                  style={trStyle}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("[data-gutter='true']")) return;
                    onRowClick?.(row);
                  }}
                  className={`transition-colors ${onRowClick ? "cursor-pointer" : ""} ${
                    selected
                      ? "bg-accent/40 hover:bg-accent/55"
                      : "bg-card hover:bg-muted/35"
                  }`}
                >
                  {/* Sticky # Gutter with Row Resize Handle */}
                  <td
                    data-gutter="true"
                    style={{
                      width: "44px",
                      minWidth: "44px",
                      maxWidth: "44px",
                      ...trStyle,
                    }}
                    className="sticky left-0 z-10 relative border-r border-border bg-muted/60 px-1 py-1.5 text-center font-mono text-[11px] text-muted-foreground align-top select-none"
                  >
                    <div
                      className="w-full max-w-full h-full overflow-hidden break-words"
                      style={innerMaxH}
                    >
                      {rowIndex + 1}
                    </div>
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={`Resize row ${rowIndex + 1}`}
                      title="Drag to resize row height (double-click to reset)"
                      onMouseDown={(e) => startRowResize(e, rowIndex)}
                      onDoubleClick={(e) => resetSingleRow(e, rowIndex)}
                      className="absolute left-0 right-0 bottom-0 z-20 h-2 w-full cursor-row-resize hover:bg-primary/35"
                    />
                  </td>

                  {columns.map((col) => {
                    const colW = mergedColWidths[col.id] ?? col.defaultWidth ?? 160;
                    return (
                      <td
                        key={col.id}
                        style={{
                          width: `${colW}px`,
                          minWidth: `${colW}px`,
                          maxWidth: `${colW}px`,
                          ...trStyle,
                        }}
                        className="border-r border-border/60 px-3 py-1.5 align-top text-xs text-foreground"
                      >
                        <div
                          className="w-full max-w-full h-full overflow-hidden break-words"
                          style={innerMaxH}
                        >
                          {col.renderCell(row, rowIndex)}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
