/**
 * SparseLinearSolver
 *
 * Sparse conjugate-gradient solver used by HeatSkinningWeights to solve the
 * heat-equation system  (M - t·L) u = b  for each bone.
 *
 * The sparse matrix is stored in Compressed Sparse Row (CSR) format for
 * cache-friendly row-major traversal required by CG.
 */

// ─── CSR Matrix ──────────────────────────────────────────────────────────────

export interface CSRMatrix {
  /** Number of rows (= number of columns for square matrices) */
  n: number
  /** Non-zero values, in row-major order */
  values: Float64Array
  /** Column indices parallel to `values` */
  col_indices: Int32Array
  /** row_ptr[i]..row_ptr[i+1] gives the range of entries for row i */
  row_ptr: Int32Array
}

/**
 * Build a CSRMatrix from a dense list of (row, col, value) triplets.
 * Duplicate (row, col) entries are summed (accumulate = true by default).
 */
export function csr_from_triplets (
  n: number,
  rows: number[],
  cols: number[],
  vals: number[]
): CSRMatrix {
  // Accumulate into a Map keyed by row*n+col
  const map = new Map<number, number>()
  for (let k = 0; k < vals.length; k++) {
    const key = rows[k] * n + cols[k]
    map.set(key, (map.get(key) ?? 0) + vals[k])
  }

  // Sort entries row-then-col
  const entries = Array.from(map.entries()).sort((a, b) => a[0] - b[0])

  const nnz = entries.length
  const values = new Float64Array(nnz)
  const col_indices = new Int32Array(nnz)
  const row_ptr = new Int32Array(n + 1)

  for (let k = 0; k < nnz; k++) {
    const key = entries[k][0]
    const r = Math.floor(key / n)
    values[k] = entries[k][1]
    col_indices[k] = key - r * n
    row_ptr[r + 1]++
  }
  // prefix-sum row_ptr
  for (let r = 0; r < n; r++) {
    row_ptr[r + 1] += row_ptr[r]
  }

  return { n, values, col_indices, row_ptr }
}

/** Sparse matrix-vector product: y = A·x */
function spmv (A: CSRMatrix, x: Float64Array, y: Float64Array): void {
  const { n, values, col_indices, row_ptr } = A
  for (let r = 0; r < n; r++) {
    let sum = 0
    for (let k = row_ptr[r]; k < row_ptr[r + 1]; k++) {
      sum += values[k] * x[col_indices[k]]
    }
    y[r] = sum
  }
}

// ─── Conjugate-Gradient Solver ────────────────────────────────────────────────

/**
 * Solve A·x = b using the Preconditioned Conjugate Gradient method.
 * Uses diagonal (Jacobi) preconditioning.
 *
 * @param A         - Symmetric positive (semi-)definite CSR matrix
 * @param b         - Right-hand side vector (length A.n)
 * @param x0        - Initial guess (modified in place and returned)
 * @param max_iter  - Maximum CG iterations (default 400)
 * @param tol       - Residual tolerance (default 1e-6)
 * @returns         - Solution vector x
 */
export function cg_solve (
  A: CSRMatrix,
  b: Float64Array,
  x0?: Float64Array,
  max_iter = 400,
  tol = 1e-6
): Float64Array {
  const n = A.n
  const x = x0 ?? new Float64Array(n)

  // Diagonal preconditioner M⁻¹  (1/A[i,i])
  const inv_diag = new Float64Array(n)
  for (let r = 0; r < n; r++) {
    for (let k = A.row_ptr[r]; k < A.row_ptr[r + 1]; k++) {
      if (A.col_indices[k] === r) {
        const d = A.values[k]
        inv_diag[r] = d !== 0 ? 1.0 / d : 1.0
        break
      }
    }
    if (inv_diag[r] === 0) inv_diag[r] = 1.0
  }

  const r_vec = new Float64Array(n)
  const z = new Float64Array(n)
  const p = new Float64Array(n)
  const Ap = new Float64Array(n)

  // r = b - A·x
  spmv(A, x, Ap)
  for (let i = 0; i < n; i++) r_vec[i] = b[i] - Ap[i]

  // z = M⁻¹ · r
  for (let i = 0; i < n; i++) z[i] = inv_diag[i] * r_vec[i]

  // p = z
  for (let i = 0; i < n; i++) p[i] = z[i]

  let rz = dot(r_vec, z)
  const b_norm = Math.sqrt(dot(b, b))
  const tol_sq = (tol * (b_norm > 0 ? b_norm : 1)) ** 2

  for (let iter = 0; iter < max_iter; iter++) {
    spmv(A, p, Ap)
    const pAp = dot(p, Ap)
    if (Math.abs(pAp) < 1e-300) break

    const alpha = rz / pAp
    for (let i = 0; i < n; i++) x[i] += alpha * p[i]
    for (let i = 0; i < n; i++) r_vec[i] -= alpha * Ap[i]

    const r_norm_sq = dot(r_vec, r_vec)
    if (r_norm_sq < tol_sq) break

    for (let i = 0; i < n; i++) z[i] = inv_diag[i] * r_vec[i]
    const rz_new = dot(r_vec, z)
    const beta = rz_new / rz
    rz = rz_new

    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i]
  }

  return x
}

function dot (a: Float64Array, b: Float64Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
