/**
 * SkeletonExtractor
 *
 * Geometry-driven skeleton generation based on the Pinocchio algorithm
 * (Baran & Popović, SIGGRAPH 2007).
 *
 * Pipeline:
 *   1. Voxelize the mesh into a 3-D boolean occupancy grid.
 *   2. Compute an approximate Euclidean Distance Transform (EDT) via BFS.
 *   3. Extract the medial axis via iterative topological thinning
 *      (Lee–Kashyap–Chu 1994 style).
 *   4. Build a skeleton graph and prune short branches.
 *   5. Convert the pruned graph into a Three.js Bone hierarchy.
 */

import {
  Bone,
  type BufferGeometry,
  Object3D,
  Raycaster,
  Vector3,
  Mesh,
  MeshBasicMaterial,
  DoubleSide,
  Box3,
} from 'three'

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SkeletonExtractorOptions {
  /**
   * Side length of the cubic voxel grid.
   * Larger values produce more accurate skeletons at higher CPU cost.
   * @default 32
   */
  grid_size?: number

  /**
   * Minimum branch length (voxels) kept during graph pruning.
   * @default 4
   */
  min_branch_length?: number
}

// ─── Internal graph types ─────────────────────────────────────────────────────

interface SkeletonGraph {
  /** voxel flat-index → list of 26-connected neighbour flat-indices */
  adjacency: Map<number, number[]>
  /** voxels that are endpoints or junctions (degree ≠ 2) */
  junctions: Set<number>
}

interface BoneChain {
  start: number
  end: number
  length: number
}

// ─── SkeletonExtractor ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class SkeletonExtractor {
  /**
   * Extract a skeleton from a BufferGeometry and return it as a Three.js
   * Object3D whose children are Bone objects.
   */
  public static extract (
    geometry: BufferGeometry,
    options: SkeletonExtractorOptions = {}
  ): Object3D {
    const G = options.grid_size ?? 32
    const min_branch = options.min_branch_length ?? 4

    // ── Bounding box ──────────────────────────────────────────────────────
    geometry.computeBoundingBox()
    const bbox = geometry.boundingBox ?? new Box3()
    const span = new Vector3()
    bbox.getSize(span)

    if (span.length() < 1e-6) return make_fallback_armature(bbox)

    const pad = 0.02
    const min_pt = bbox.min.clone().subScalar(pad)
    span.addScalar(pad * 2)

    // ── Utility functions ─────────────────────────────────────────────────
    const flat = (x: number, y: number, z: number): number => x + y * G + z * G * G

    const in_b = (x: number, y: number, z: number): boolean =>
      x >= 0 && y >= 0 && z >= 0 && x < G && y < G && z < G

    const flat_to_world = (f: number): Vector3 => {
      const fz = Math.floor(f / (G * G))
      const fy = Math.floor((f - fz * G * G) / G)
      const fx = f - fz * G * G - fy * G
      return new Vector3(
        min_pt.x + (fx + 0.5) * span.x / G,
        min_pt.y + (fy + 0.5) * span.y / G,
        min_pt.z + (fz + 0.5) * span.z / G
      )
    }

    const dx6 = [1, -1, 0, 0, 0, 0]
    const dy6 = [0, 0, 1, -1, 0, 0]
    const dz6 = [0, 0, 0, 0, 1, -1]

    const nbr26: [number, number, number][] = []
    for (let ddx = -1; ddx <= 1; ddx++)
      for (let ddy = -1; ddy <= 1; ddy++)
        for (let ddz = -1; ddz <= 1; ddz++)
          if (ddx !== 0 || ddy !== 0 || ddz !== 0)
            nbr26.push([ddx, ddy, ddz])

    // ── 1. Voxelise ───────────────────────────────────────────────────────
    const N = G * G * G
    const occ = new Uint8Array(N)  // 1 = inside mesh

    const temp_mesh = new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }))
    const ray = new Raycaster()

    for (let vx = 0; vx < G; vx++) {
      for (let vz = 0; vz < G; vz++) {
        const wx = min_pt.x + (vx + 0.5) * span.x / G
        const wz = min_pt.z + (vz + 0.5) * span.z / G

        ray.set(new Vector3(wx, min_pt.y + span.y + 1, wz), new Vector3(0, -1, 0))
        const hits = ray.intersectObject(temp_mesh, false)
        hits.sort((a, b) => b.point.y - a.point.y)

        let inside = false
        let hi = 0
        for (let vy = G - 1; vy >= 0; vy--) {
          const wy = min_pt.y + (vy + 0.5) * span.y / G
          while (hi < hits.length && hits[hi].point.y >= wy) { inside = !inside; hi++ }
          if (inside) occ[flat(vx, vy, vz)] = 1
        }
      }
    }

    // ── 2. Approximate EDT via 26-connected BFS ────────────────────────────
    const dist = new Float32Array(N)
    for (let i = 0; i < N; i++) dist[i] = occ[i] === 1 ? 1e9 : 0

    // Surface voxels (interior with an exterior face-neighbour) get dist = 0
    for (let vx = 0; vx < G; vx++) {
      for (let vy = 0; vy < G; vy++) {
        for (let vz = 0; vz < G; vz++) {
          if (occ[flat(vx, vy, vz)] === 0) continue
          for (let d = 0; d < 6; d++) {
            const nx = vx + dx6[d], ny = vy + dy6[d], nz = vz + dz6[d]
            if (!in_b(nx, ny, nz) || occ[flat(nx, ny, nz)] === 0) {
              dist[flat(vx, vy, vz)] = 0
              break
            }
          }
        }
      }
    }

    // BFS propagation
    const q: number[] = []
    for (let i = 0; i < N; i++) { if (dist[i] === 0 && occ[i] === 1) q.push(i) }
    let qh = 0
    while (qh < q.length) {
      const f0 = q[qh++]
      const fz = Math.floor(f0 / (G * G))
      const fy = Math.floor((f0 - fz * G * G) / G)
      const fx = f0 - fz * G * G - fy * G
      const cd = dist[f0]
      for (const [ddx, ddy, ddz] of nbr26) {
        const nx = fx + ddx, ny = fy + ddy, nz = fz + ddz
        if (!in_b(nx, ny, nz) || occ[flat(nx, ny, nz)] === 0) continue
        const nd = cd + Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz)
        const ni = flat(nx, ny, nz)
        if (nd < dist[ni]) { dist[ni] = nd; q.push(ni) }
      }
    }

    // ── 3. Topological thinning ────────────────────────────────────────────
    const thin = new Uint8Array(occ)

    // Connectivity check: BFS within 26-neighbourhood of (vx,vy,vz) excluding that voxel
    const is_simple = (vx: number, vy: number, vz: number): boolean => {
      const nbrs: number[] = []
      for (const [ddx, ddy, ddz] of nbr26) {
        const nx = vx + ddx, ny = vy + ddy, nz = vz + ddz
        if (in_b(nx, ny, nz) && thin[flat(nx, ny, nz)] === 1) nbrs.push(flat(nx, ny, nz))
      }
      if (nbrs.length === 0) return false

      const ns = new Set(nbrs)
      const vis = new Set<number>([nbrs[0]])
      const stk = [nbrs[0]]
      while (stk.length > 0) {
        const cur = stk.pop()!
        const cz = Math.floor(cur / (G * G))
        const cy = Math.floor((cur - cz * G * G) / G)
        const cx = cur - cz * G * G - cy * G
        for (const [ddx2, ddy2, ddz2] of nbr26) {
          const nx2 = cx + ddx2, ny2 = cy + ddy2, nz2 = cz + ddz2
          if (!in_b(nx2, ny2, nz2)) continue
          const ni = flat(nx2, ny2, nz2)
          if (ns.has(ni) && !vis.has(ni)) { vis.add(ni); stk.push(ni) }
        }
      }
      return vis.size === nbrs.length
    }

    let changed = true
    let passes = G
    while (changed && passes-- > 0) {
      changed = false
      for (let vx = 0; vx < G; vx++) {
        for (let vy = 0; vy < G; vy++) {
          for (let vz = 0; vz < G; vz++) {
            const fi = flat(vx, vy, vz)
            if (thin[fi] === 0) continue

            // Only remove border voxels
            let is_border = false
            for (let d = 0; d < 6; d++) {
              const nx = vx + dx6[d], ny = vy + dy6[d], nz = vz + dz6[d]
              if (!in_b(nx, ny, nz) || thin[flat(nx, ny, nz)] === 0) { is_border = true; break }
            }
            if (!is_border) continue

            // Prioritise removal of low-EDT voxels (surface-adjacent first)
            if (dist[fi] < 1.5 && is_simple(vx, vy, vz)) {
              thin[fi] = 0
              changed = true
            }
          }
        }
      }
    }

    // ── 4. Build skeleton graph ────────────────────────────────────────────
    const graph: SkeletonGraph = { adjacency: new Map(), junctions: new Set() }

    for (let vx = 0; vx < G; vx++) {
      for (let vy = 0; vy < G; vy++) {
        for (let vz = 0; vz < G; vz++) {
          const fi = flat(vx, vy, vz)
          if (thin[fi] === 0) continue
          const nbrs: number[] = []
          for (const [ddx, ddy, ddz] of nbr26) {
            const nx = vx + ddx, ny = vy + ddy, nz = vz + ddz
            if (in_b(nx, ny, nz) && thin[flat(nx, ny, nz)] === 1) nbrs.push(flat(nx, ny, nz))
          }
          graph.adjacency.set(fi, nbrs)
          if (nbrs.length !== 2) graph.junctions.add(fi)
        }
      }
    }

    // If no junctions, treat all endpoints (degree ≤ 1) as junctions
    if (graph.junctions.size === 0) {
      for (const [v, nbrs] of graph.adjacency.entries()) {
        if (nbrs.length <= 1) graph.junctions.add(v)
      }
    }

    // ── 5. Extract chains and prune short ones ─────────────────────────────
    const chains = trace_chains(graph)
    const kept = chains.filter(c => c.length >= min_branch)

    if (kept.length === 0) return make_fallback_armature(bbox)

    // ── 6. Build Bone hierarchy ────────────────────────────────────────────
    return build_bones(kept, graph, flat_to_world)
  }
}

// ─── Chain tracing ────────────────────────────────────────────────────────────

function trace_chains (graph: SkeletonGraph): BoneChain[] {
  const chains: BoneChain[] = []
  const visited = new Set<string>()

  for (const start of graph.junctions) {
    for (const nbr of (graph.adjacency.get(start) ?? [])) {
      const ek = edge_key(start, nbr)
      if (visited.has(ek)) continue

      let prev = start
      let cur = nbr
      let length = 1
      visited.add(ek)

      while (!graph.junctions.has(cur)) {
        const nexts = (graph.adjacency.get(cur) ?? []).filter(n => n !== prev)
        if (nexts.length === 0) break
        const next = nexts[0]
        const nek = edge_key(cur, next)
        if (visited.has(nek)) break
        visited.add(nek)
        prev = cur
        cur = next
        length++
      }

      chains.push({ start, end: cur, length })
    }
  }

  return chains
}

function edge_key (a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`
}

// ─── Bone hierarchy builder ───────────────────────────────────────────────────

function build_bones (
  chains: BoneChain[],
  graph: SkeletonGraph,
  flat_to_world: (f: number) => Vector3
): Object3D {
  const armature = new Object3D()
  armature.name = 'Generated Armature'

  const bone_map = new Map<number, Bone>()
  let bone_idx = 0

  const get_bone = (flat_v: number): Bone => {
    if (bone_map.has(flat_v)) return bone_map.get(flat_v)!
    const b = new Bone()
    b.name = `bone_${bone_idx++}`
    b.position.copy(flat_to_world(flat_v))
    bone_map.set(flat_v, b)
    return b
  }

  // Pre-create all joint bones
  const junction_set = new Set<number>()
  for (const c of chains) { junction_set.add(c.start); junction_set.add(c.end) }
  for (const v of junction_set) get_bone(v)

  // Choose root: junction with most connections (most chain-links)
  const connection_count = new Map<number, number>()
  for (const c of chains) {
    connection_count.set(c.start, (connection_count.get(c.start) ?? 0) + 1)
    connection_count.set(c.end, (connection_count.get(c.end) ?? 0) + 1)
  }
  let root_v = chains[0].start
  let max_conn = 0
  for (const [v, cnt] of connection_count.entries()) {
    if (cnt > max_conn) { max_conn = cnt; root_v = v }
  }

  // BFS to build parent-child relationships
  const visited_v = new Set<number>([root_v])
  const bfs: number[] = [root_v]
  let bh = 0
  while (bh < bfs.length) {
    const cur_v = bfs[bh++]
    const cur_bone = get_bone(cur_v)

    for (const chain of chains) {
      let child_v: number | null = null
      if (chain.start === cur_v && !visited_v.has(chain.end)) child_v = chain.end
      else if (chain.end === cur_v && !visited_v.has(chain.start)) child_v = chain.start

      if (child_v !== null) {
        visited_v.add(child_v)
        bfs.push(child_v)
        const child_bone = get_bone(child_v)
        // Convert child world position to parent-local
        const parent_world = flat_to_world(cur_v)
        const child_world = flat_to_world(child_v)
        child_bone.position.copy(child_world.clone().sub(parent_world))
        cur_bone.add(child_bone)
      }
    }
  }

  armature.add(get_bone(root_v))
  return armature
}

// ─── Fallback ─────────────────────────────────────────────────────────────────

function make_fallback_armature (bbox: Box3): Object3D {
  const armature = new Object3D()
  armature.name = 'Generated Armature'
  const centre = new Vector3()
  bbox.getCenter(centre)
  const root = new Bone()
  root.name = 'bone_root'
  root.position.copy(centre)
  armature.add(root)
  return armature
}
