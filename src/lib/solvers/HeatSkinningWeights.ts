/**
 * HeatSkinningWeights
 *
 * Computes per-vertex bone weights using the heat-diffusion method described in:
 *   Crane, Weischedel & Wardetzky — "Geodesics in Heat" (ACM TOG 2013)
 *   and the bone-influence adaptation from:
 *   Jacobson, Baran, Popović & Sorkine — "Bounded Biharmonic Weights" (ACM TOG 2011)
 *
 * Algorithm overview (for each bone):
 *   1. Build the cotangent-weight Laplacian matrix L and lumped mass matrix M.
 *   2. Solve  (M + t·L) u = b  where b is 1 at vertices closest to that bone
 *      and 0 elsewhere.  The solution u approximates the geodesic influence.
 *   3. Repeat for every bone, then row-normalise so weights sum to 1 per vertex.
 *
 * The result is returned as flat arrays compatible with Three.js
 * `skinIndex` / `skinWeight` BufferAttributes (4 influences per vertex).
 */

import { type Bone, BufferGeometry, Vector3 } from 'three'
import { Utility } from '../Utilities.js'
import { cg_solve, csr_from_triplets, type CSRMatrix } from './SparseLinearSolver.js'

// ─── Public API ───────────────────────────────────────────────────────────────

export interface HeatWeightResult {
  /** Flat skin-index array (4 per vertex) compatible with Three.js */
  skin_indices: number[]
  /** Flat skin-weight array (4 per vertex) compatible with Three.js */
  skin_weights: number[]
}

// ─── HeatSkinningWeights ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class HeatSkinningWeights {
  /**
   * Compute heat-diffusion bone weights for the given geometry and bone list.
   *
   * @param geometry  - The mesh BufferGeometry (must have `position` attribute)
   * @param bones     - Ordered list of Bone objects (world matrices must be up-to-date)
   * @param time_step - Heat diffusion time parameter t (default: auto from avg edge length)
   * @param max_influences - Maximum non-zero influences per vertex (default: 4)
   */
  public static compute (
    geometry: BufferGeometry,
    bones: Bone[],
    time_step: number | null = null,
    max_influences = 4
  ): HeatWeightResult {
    const pos_attr = geometry.attributes.position
    const V = pos_attr.count  // vertex count

    if (V === 0 || bones.length === 0) {
      return { skin_indices: [], skin_weights: [] }
    }

    // ── Collect triangle faces ─────────────────────────────────────────────
    const faces: [number, number, number][] = collect_faces(geometry)

    if (faces.length === 0) {
      return fallback_closest_bone(geometry, bones)
    }

    // ── Build cotangent Laplacian L and mass matrix M ─────────────────────
    const { L, M } = build_laplacian_and_mass(V, faces, geometry)

    // ── Auto time-step from mean squared edge length  (Crane 2013 §5) ────
    const t = time_step ?? compute_time_step(faces, geometry)

    // ── Build system matrix A = M + t·L ─────────────────────────────────
    const A = build_heat_system(V, M, L, t)

    // ── Bone positions: midpoint of each bone segment ─────────────────────
    const bone_midpoints = bones.map(b => {
      const bp = Utility.world_position_from_object(b)
      if (b.children.length > 0) {
        const cp = Utility.world_position_from_object(b.children[0] as Bone)
        return bp.lerp(cp, 0.5)
      }
      return bp
    })

    // ── Heat solve for each bone ──────────────────────────────────────────
    // Each row will hold the influence values for one bone (indexed by bone)
    const raw_weights: Float64Array[] = []

    for (let bi = 0; bi < bones.length; bi++) {
      // Build RHS: 1 at vertex closest to bone midpoint, 0 elsewhere
      const rhs = new Float64Array(V)
      let min_d = Infinity
      let seed_v = 0
      for (let vi = 0; vi < V; vi++) {
        const vp = new Vector3().fromBufferAttribute(pos_attr, vi)
        const d = bone_midpoints[bi].distanceToSquared(vp)
        if (d < min_d) { min_d = d; seed_v = vi }
      }
      rhs[seed_v] = 1.0

      // Solve
      const u = cg_solve(A, rhs, undefined, 300, 1e-5)
      // Clamp to [0, 1]
      for (let i = 0; i < V; i++) u[i] = Math.max(0, Math.min(1, u[i]))
      raw_weights.push(u)
    }

    // ── Row-normalise (per vertex, sum over bones) ────────────────────────
    const norm_weights: number[][] = []
    for (let vi = 0; vi < V; vi++) {
      let total = 0
      for (let bi = 0; bi < bones.length; bi++) total += raw_weights[bi][vi]
      const row: number[] = []
      if (total < 1e-10) {
        // Assign entirely to closest bone as fallback
        const closest_bi = closest_bone_index(vi, bone_midpoints, pos_attr)
        for (let bi = 0; bi < bones.length; bi++) row.push(bi === closest_bi ? 1 : 0)
      } else {
        for (let bi = 0; bi < bones.length; bi++) row.push(raw_weights[bi][vi] / total)
      }
      norm_weights.push(row)
    }

    // ── Pack into Three.js 4-influence format ─────────────────────────────
    const skin_indices: number[] = []
    const skin_weights: number[] = []

    for (let vi = 0; vi < V; vi++) {
      // Pick top `max_influences` bones by weight
      const indexed = norm_weights[vi]
        .map((w, bi) => [bi, w] as [number, number])
        .filter(([, w]) => w > 1e-6)
        .sort((a, b) => b[1] - a[1])
        .slice(0, max_influences)

      // Renormalise the top influences
      let top_sum = indexed.reduce((s, [, w]) => s + w, 0)
      if (top_sum < 1e-10) top_sum = 1

      for (let k = 0; k < 4; k++) {
        if (k < indexed.length) {
          skin_indices.push(indexed[k][0])
          skin_weights.push(indexed[k][1] / top_sum)
        } else {
          skin_indices.push(0)
          skin_weights.push(0)
        }
      }
    }

    return { skin_indices, skin_weights }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function collect_faces (geometry: BufferGeometry): [number, number, number][] {
  const faces: [number, number, number][] = []
  const index = geometry.index

  if (index !== null) {
    for (let i = 0; i + 2 < index.count; i += 3) {
      faces.push([index.getX(i), index.getX(i + 1), index.getX(i + 2)])
    }
  } else {
    const n = geometry.attributes.position.count
    for (let i = 0; i + 2 < n; i += 3) {
      faces.push([i, i + 1, i + 2])
    }
  }
  return faces
}

interface LaplacianResult {
  L: CSRMatrix
  M: Float64Array  // lumped mass (diagonal), stored as flat array
}

function build_laplacian_and_mass (
  V: number,
  faces: [number, number, number][],
  geometry: BufferGeometry
): LaplacianResult {
  const pos = geometry.attributes.position
  const l_rows: number[] = []
  const l_cols: number[] = []
  const l_vals: number[] = []
  const M = new Float64Array(V)

  for (const [i, j, k] of faces) {
    const pi = new Vector3().fromBufferAttribute(pos, i)
    const pj = new Vector3().fromBufferAttribute(pos, j)
    const pk = new Vector3().fromBufferAttribute(pos, k)

    // Cotangent weights at each corner:
    //   cot(angle at i) for edge j-k, etc.
    const cot_i = cot_angle(pj.clone().sub(pi), pk.clone().sub(pi))
    const cot_j = cot_angle(pi.clone().sub(pj), pk.clone().sub(pj))
    const cot_k = cot_angle(pi.clone().sub(pk), pj.clone().sub(pk))

    // Triangle area for mass matrix
    const area = 0.5 * pj.clone().sub(pi).cross(pk.clone().sub(pi)).length()
    const area_sixth = area / 6

    // Lumped mass: one-third of triangle area to each vertex
    M[i] += area_sixth * 2
    M[j] += area_sixth * 2
    M[k] += area_sixth * 2

    // Cotangent Laplacian contributions (symmetric)
    // edge i-j: weight = 0.5 * (cot_k)  [cot at the opposite vertex k]
    const w_ij = 0.5 * cot_k
    const w_jk = 0.5 * cot_i
    const w_ik = 0.5 * cot_j

    add_laplacian_edge(l_rows, l_cols, l_vals, i, j, w_ij)
    add_laplacian_edge(l_rows, l_cols, l_vals, j, k, w_jk)
    add_laplacian_edge(l_rows, l_cols, l_vals, i, k, w_ik)
  }

  const L = csr_from_triplets(V, l_rows, l_cols, l_vals)
  return { L, M }
}

/** Add symmetric Laplacian entries for one undirected edge (u-v, weight w). */
function add_laplacian_edge (
  rows: number[], cols: number[], vals: number[],
  u: number, v: number, w: number
): void {
  // L[u,v] -= w,  L[v,u] -= w
  // L[u,u] += w,  L[v,v] += w
  rows.push(u, v, u, v)
  cols.push(v, u, u, v)
  vals.push(-w, -w, w, w)
}

/** Cotangent of the angle between two vectors a and b. */
function cot_angle (a: Vector3, b: Vector3): number {
  const cos_theta = a.dot(b)
  const sin_theta = a.clone().cross(b).length()
  return sin_theta > 1e-10 ? cos_theta / sin_theta : 0
}

/** t = h² where h = average squared edge length (Crane 2013). */
function compute_time_step (
  faces: [number, number, number][],
  geometry: BufferGeometry
): number {
  const pos = geometry.attributes.position
  let total_len_sq = 0
  let edge_count = 0
  for (const [i, j, k] of faces) {
    const pi = new Vector3().fromBufferAttribute(pos, i)
    const pj = new Vector3().fromBufferAttribute(pos, j)
    const pk = new Vector3().fromBufferAttribute(pos, k)
    total_len_sq += pi.distanceToSquared(pj) + pj.distanceToSquared(pk) + pi.distanceToSquared(pk)
    edge_count += 3
  }
  const avg_len_sq = edge_count > 0 ? total_len_sq / edge_count : 1
  return avg_len_sq
}

/**
 * Build the heat system matrix A = M + t·L as a CSR matrix.
 * M is the diagonal mass matrix (stored as vector), so A[i,i] = M[i] + t·L[i,i].
 */
function build_heat_system (
  V: number,
  M: Float64Array,
  L: CSRMatrix,
  t: number
): CSRMatrix {
  // Copy L and scale by t, then add M to the diagonal
  const values = new Float64Array(L.values.length)
  for (let k = 0; k < L.values.length; k++) values[k] = t * L.values[k]

  // Add diagonal mass terms  M[i]  to  A[i,i]
  for (let r = 0; r < V; r++) {
    for (let k = L.row_ptr[r]; k < L.row_ptr[r + 1]; k++) {
      if (L.col_indices[k] === r) {
        values[k] += M[r]
        break
      }
    }
  }

  // If M[r] had no diagonal entry in L (shouldn't happen for a closed mesh but guard it)
  // We'd need to insert one — csr_from_triplets handles this, so rebuild if needed.
  // For robustness, rebuild from triplets:
  const rows: number[] = []
  const cols: number[] = []
  const vals: number[] = []

  // Off-diagonal terms (from L)
  for (let r = 0; r < V; r++) {
    for (let k = L.row_ptr[r]; k < L.row_ptr[r + 1]; k++) {
      const c = L.col_indices[k]
      if (c !== r) {
        rows.push(r); cols.push(c); vals.push(t * L.values[k])
      }
    }
  }

  // Diagonal terms: t·L[i,i] + M[i]
  // First collect L diagonal
  const l_diag = new Float64Array(V)
  for (let r = 0; r < V; r++) {
    for (let k = L.row_ptr[r]; k < L.row_ptr[r + 1]; k++) {
      if (L.col_indices[k] === r) { l_diag[r] = L.values[k]; break }
    }
  }
  for (let r = 0; r < V; r++) {
    rows.push(r); cols.push(r); vals.push(t * l_diag[r] + M[r])
  }

  return csr_from_triplets(V, rows, cols, vals)
}

function closest_bone_index (
  vi: number,
  midpoints: Vector3[],
  pos_attr: { getX: (i: number) => number; getY: (i: number) => number; getZ: (i: number) => number }
): number {
  const vp = new Vector3(pos_attr.getX(vi), pos_attr.getY(vi), pos_attr.getZ(vi))
  let best = 0
  let min_d = Infinity
  for (let bi = 0; bi < midpoints.length; bi++) {
    const d = midpoints[bi].distanceToSquared(vp)
    if (d < min_d) { min_d = d; best = bi }
  }
  return best
}

/** Fallback when geometry has no faces: use closest-bone assignment. */
function fallback_closest_bone (
  geometry: BufferGeometry,
  bones: Bone[]
): HeatWeightResult {
  const pos = geometry.attributes.position
  const V = pos.count
  const midpoints = bones.map(b => Utility.world_position_from_object(b))
  const skin_indices: number[] = []
  const skin_weights: number[] = []
  for (let vi = 0; vi < V; vi++) {
    const bi = closest_bone_index(vi, midpoints, pos)
    skin_indices.push(bi, 0, 0, 0)
    skin_weights.push(1, 0, 0, 0)
  }
  return { skin_indices, skin_weights }
}
