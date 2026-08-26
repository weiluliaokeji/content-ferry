import type { Dispatch, SetStateAction } from "react";

export interface PaginationProps {
  page: number;
  totalPages: number;
  pageSize: number;
  totalItems: number;
  setPage: Dispatch<SetStateAction<number>>;
  setPageSize: Dispatch<SetStateAction<number>>;
  pageSizeOptions: number[];
  className?: string;
}

export function Pagination({
  page,
  totalPages,
  pageSize,
  totalItems,
  setPage,
  setPageSize,
  pageSizeOptions,
  className = "library-pagination"
}: PaginationProps) {
  return (
    <div className={className}>
      <span className="pagination-total">共 {totalItems} 条</span>
      <label className="pagination-size-label">
        <span>每页</span>
        <select
          className="pagination-size"
          value={pageSize}
          onChange={(event) => {
            setPage(1);
            setPageSize(Number(event.target.value));
          }}
        >
          {pageSizeOptions.map((size) => (
            <option key={size} value={size}>{size} 条</option>
          ))}
        </select>
      </label>
      <button
        className="secondary-button"
        disabled={page <= 1}
        onClick={() => { setPage((p) => Math.max(1, p - 1)); }}
      >
        上一页
      </button>
      <span className="library-pagination-info">{page} / {totalPages}</span>
      <button
        className="secondary-button"
        disabled={page >= totalPages}
        onClick={() => { setPage((p) => Math.min(totalPages, p + 1)); }}
      >
        下一页
      </button>
    </div>
  );
}
