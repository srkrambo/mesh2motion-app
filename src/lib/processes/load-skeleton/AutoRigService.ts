import {
  Box3,
  Vector3,
  Matrix4,
  type Object3D,
  type Bone,
} from 'three'
import { SkeletonType } from '../../enums/SkeletonType.ts'

// Normalized position ratio [x, y, z] where each component is in [0, 1]:
//   x: 0 = bbox left, 1 = bbox right
//   y: 0 = bbox bottom, 1 = bbox top
//   z: 0 = bbox front, 1 = bbox back (0.5 = depth center)
type BoneRatio = [number, number, number]

// Maps partial bone-name keywords (all lowercase) to a normalized position ratio.
// A bone matches an entry if its lowercase name includes ALL of the listed keywords.
interface BoneRatioEntry {
  keywords: string[]
  ratio: BoneRatio
}

// ─── Per-skeleton placement templates ────────────────────────────────────────

// Human (biped, standing upright, T-pose)
const HUMAN_RATIOS: BoneRatioEntry[] = [
  { keywords: ['pelvis'],                  ratio: [0.50, 0.53, 0.50] },
  { keywords: ['spine', '01'],             ratio: [0.50, 0.61, 0.50] },
  { keywords: ['spine', '02'],             ratio: [0.50, 0.68, 0.50] },
  { keywords: ['spine', '03'],             ratio: [0.50, 0.75, 0.50] },
  { keywords: ['neck'],                    ratio: [0.50, 0.84, 0.50] },
  { keywords: ['head'],                    ratio: [0.50, 0.92, 0.50] },
  // Left arm
  { keywords: ['upperarm_l'],              ratio: [0.66, 0.77, 0.50] },
  { keywords: ['lowerarm_l'],              ratio: [0.78, 0.65, 0.50] },
  { keywords: ['hand_l'],                  ratio: [0.88, 0.54, 0.50] },
  // Right arm (mirror of left)
  { keywords: ['upperarm_r'],              ratio: [0.34, 0.77, 0.50] },
  { keywords: ['lowerarm_r'],              ratio: [0.22, 0.65, 0.50] },
  { keywords: ['hand_r'],                  ratio: [0.12, 0.54, 0.50] },
  // Left leg
  { keywords: ['thigh_l'],                 ratio: [0.57, 0.45, 0.50] },
  { keywords: ['calf_l'],                  ratio: [0.57, 0.24, 0.50] },
  { keywords: ['foot_l'],                  ratio: [0.57, 0.05, 0.50] },
  // Right leg
  { keywords: ['thigh_r'],                 ratio: [0.43, 0.45, 0.50] },
  { keywords: ['calf_r'],                  ratio: [0.43, 0.24, 0.50] },
  { keywords: ['foot_r'],                  ratio: [0.43, 0.05, 0.50] },
  // Left fingers (clustered near hand)
  { keywords: ['thumb_01_l'],              ratio: [0.90, 0.52, 0.48] },
  { keywords: ['thumb_02_l'],              ratio: [0.92, 0.50, 0.46] },
  { keywords: ['thumb_03_l'],              ratio: [0.94, 0.48, 0.44] },
  { keywords: ['thumb_04_leaf_l'],         ratio: [0.95, 0.47, 0.43] },
  { keywords: ['index_01_l'],              ratio: [0.91, 0.51, 0.50] },
  { keywords: ['index_02_l'],              ratio: [0.93, 0.50, 0.50] },
  { keywords: ['index_03_l'],              ratio: [0.95, 0.49, 0.50] },
  { keywords: ['index_04_leaf_l'],         ratio: [0.96, 0.48, 0.50] },
  { keywords: ['middle_01_l'],             ratio: [0.91, 0.51, 0.51] },
  { keywords: ['middle_02_l'],             ratio: [0.93, 0.50, 0.51] },
  { keywords: ['middle_03_l'],             ratio: [0.95, 0.49, 0.51] },
  { keywords: ['middle_04_leaf_l'],        ratio: [0.96, 0.48, 0.51] },
  { keywords: ['ring_01_l'],               ratio: [0.91, 0.51, 0.52] },
  { keywords: ['ring_02_l'],               ratio: [0.93, 0.50, 0.52] },
  { keywords: ['ring_03_l'],               ratio: [0.95, 0.49, 0.52] },
  { keywords: ['ring_04_leaf_l'],          ratio: [0.96, 0.48, 0.52] },
  { keywords: ['pinky_01_l'],              ratio: [0.91, 0.50, 0.53] },
  { keywords: ['pinky_02_l'],              ratio: [0.93, 0.49, 0.53] },
  { keywords: ['pinky_03_l'],              ratio: [0.95, 0.48, 0.53] },
  { keywords: ['pinky_04_leaf_l'],         ratio: [0.96, 0.47, 0.53] },
  // Right fingers (mirror of left)
  { keywords: ['thumb_01_r'],              ratio: [0.10, 0.52, 0.48] },
  { keywords: ['thumb_02_r'],              ratio: [0.08, 0.50, 0.46] },
  { keywords: ['thumb_03_r'],              ratio: [0.06, 0.48, 0.44] },
  { keywords: ['thumb_04_leaf_r'],         ratio: [0.05, 0.47, 0.43] },
  { keywords: ['index_01_r'],              ratio: [0.09, 0.51, 0.50] },
  { keywords: ['index_02_r'],              ratio: [0.07, 0.50, 0.50] },
  { keywords: ['index_03_r'],              ratio: [0.05, 0.49, 0.50] },
  { keywords: ['index_04_leaf_r'],         ratio: [0.04, 0.48, 0.50] },
  { keywords: ['middle_01_r'],             ratio: [0.09, 0.51, 0.51] },
  { keywords: ['middle_02_r'],             ratio: [0.07, 0.50, 0.51] },
  { keywords: ['middle_03_r'],             ratio: [0.05, 0.49, 0.51] },
  { keywords: ['middle_04_leaf_r'],        ratio: [0.04, 0.48, 0.51] },
  { keywords: ['ring_01_r'],               ratio: [0.09, 0.51, 0.52] },
  { keywords: ['ring_02_r'],               ratio: [0.07, 0.50, 0.52] },
  { keywords: ['ring_03_r'],               ratio: [0.05, 0.49, 0.52] },
  { keywords: ['ring_04_leaf_r'],          ratio: [0.04, 0.48, 0.52] },
  { keywords: ['pinky_01_r'],              ratio: [0.09, 0.50, 0.53] },
  { keywords: ['pinky_02_r'],              ratio: [0.07, 0.49, 0.53] },
  { keywords: ['pinky_03_r'],              ratio: [0.05, 0.48, 0.53] },
  { keywords: ['pinky_04_leaf_r'],         ratio: [0.04, 0.47, 0.53] },
]

// Fox / quadruped (body horizontal, head forward along -Z)
const FOX_RATIOS: BoneRatioEntry[] = [
  { keywords: ['hips'],                    ratio: [0.50, 0.55, 0.45] },
  { keywords: ['spine', '01'],             ratio: [0.50, 0.57, 0.38] },
  { keywords: ['spine', '02'],             ratio: [0.50, 0.59, 0.30] },
  { keywords: ['spine', '03'],             ratio: [0.50, 0.60, 0.22] },
  { keywords: ['neck'],                    ratio: [0.50, 0.65, 0.16] },
  { keywords: ['head'],                    ratio: [0.50, 0.62, 0.08] },
  // Front legs (arms)
  { keywords: ['upperarm_l'],              ratio: [0.65, 0.53, 0.20] },
  { keywords: ['lowerarm_l'],              ratio: [0.66, 0.35, 0.17] },
  { keywords: ['hand_l'],                  ratio: [0.66, 0.08, 0.15] },
  { keywords: ['upperarm_r'],              ratio: [0.35, 0.53, 0.20] },
  { keywords: ['lowerarm_r'],              ratio: [0.34, 0.35, 0.17] },
  { keywords: ['hand_r'],                  ratio: [0.34, 0.08, 0.15] },
  // Back legs
  { keywords: ['thigh_l'],                 ratio: [0.63, 0.52, 0.70] },
  { keywords: ['calf_l'],                  ratio: [0.64, 0.30, 0.72] },
  { keywords: ['foot_l'],                  ratio: [0.64, 0.05, 0.74] },
  { keywords: ['thigh_r'],                 ratio: [0.37, 0.52, 0.70] },
  { keywords: ['calf_r'],                  ratio: [0.36, 0.30, 0.72] },
  { keywords: ['foot_r'],                  ratio: [0.36, 0.05, 0.74] },
  // Tail
  { keywords: ['tail', '01'],              ratio: [0.50, 0.60, 0.72] },
  { keywords: ['tail', '02'],              ratio: [0.50, 0.65, 0.82] },
  { keywords: ['tail', '03'],              ratio: [0.50, 0.70, 0.90] },
  { keywords: ['tail', '04'],              ratio: [0.50, 0.72, 0.96] },
  // Ears
  { keywords: ['ear_l'],                   ratio: [0.60, 0.85, 0.08] },
  { keywords: ['ear_r'],                   ratio: [0.40, 0.85, 0.08] },
]

// Bird (biped, wings instead of arms, upright torso)
const BIRD_RATIOS: BoneRatioEntry[] = [
  { keywords: ['hips'],                    ratio: [0.50, 0.45, 0.50] },
  { keywords: ['spine', '01'],             ratio: [0.50, 0.55, 0.50] },
  { keywords: ['spine', '02'],             ratio: [0.50, 0.65, 0.50] },
  { keywords: ['neck'],                    ratio: [0.50, 0.78, 0.50] },
  { keywords: ['head'],                    ratio: [0.50, 0.89, 0.50] },
  // Wings (left)
  { keywords: ['upperarm_l'],              ratio: [0.68, 0.70, 0.50] },
  { keywords: ['lowerarm_l'],              ratio: [0.80, 0.58, 0.50] },
  { keywords: ['hand_l'],                  ratio: [0.90, 0.48, 0.50] },
  // Wings (right)
  { keywords: ['upperarm_r'],              ratio: [0.32, 0.70, 0.50] },
  { keywords: ['lowerarm_r'],              ratio: [0.20, 0.58, 0.50] },
  { keywords: ['hand_r'],                  ratio: [0.10, 0.48, 0.50] },
  // Legs
  { keywords: ['thigh_l'],                 ratio: [0.58, 0.38, 0.50] },
  { keywords: ['calf_l'],                  ratio: [0.58, 0.20, 0.52] },
  { keywords: ['foot_l'],                  ratio: [0.58, 0.04, 0.55] },
  { keywords: ['thigh_r'],                 ratio: [0.42, 0.38, 0.50] },
  { keywords: ['calf_r'],                  ratio: [0.42, 0.20, 0.52] },
  { keywords: ['foot_r'],                  ratio: [0.42, 0.04, 0.55] },
  // Tail feathers
  { keywords: ['tail'],                    ratio: [0.50, 0.42, 0.65] },
]

// Dragon (quadruped with wings)
const DRAGON_RATIOS: BoneRatioEntry[] = [
  { keywords: ['hips'],                    ratio: [0.50, 0.55, 0.45] },
  { keywords: ['spine', '01'],             ratio: [0.50, 0.57, 0.36] },
  { keywords: ['spine', '02'],             ratio: [0.50, 0.58, 0.27] },
  { keywords: ['spine', '03'],             ratio: [0.50, 0.60, 0.20] },
  { keywords: ['neck', '01'],              ratio: [0.50, 0.64, 0.14] },
  { keywords: ['neck', '02'],              ratio: [0.50, 0.68, 0.09] },
  { keywords: ['head'],                    ratio: [0.50, 0.65, 0.04] },
  // Front legs
  { keywords: ['upperarm_l'],              ratio: [0.64, 0.52, 0.22] },
  { keywords: ['lowerarm_l'],              ratio: [0.65, 0.32, 0.18] },
  { keywords: ['hand_l'],                  ratio: [0.65, 0.06, 0.16] },
  { keywords: ['upperarm_r'],              ratio: [0.36, 0.52, 0.22] },
  { keywords: ['lowerarm_r'],              ratio: [0.35, 0.32, 0.18] },
  { keywords: ['hand_r'],                  ratio: [0.35, 0.06, 0.16] },
  // Back legs
  { keywords: ['thigh_l'],                 ratio: [0.62, 0.50, 0.68] },
  { keywords: ['calf_l'],                  ratio: [0.63, 0.28, 0.70] },
  { keywords: ['foot_l'],                  ratio: [0.63, 0.04, 0.72] },
  { keywords: ['thigh_r'],                 ratio: [0.38, 0.50, 0.68] },
  { keywords: ['calf_r'],                  ratio: [0.37, 0.28, 0.70] },
  { keywords: ['foot_r'],                  ratio: [0.37, 0.04, 0.72] },
  // Wings (large spread)
  { keywords: ['wing', 'l', '01'],         ratio: [0.70, 0.65, 0.35] },
  { keywords: ['wing', 'l', '02'],         ratio: [0.82, 0.68, 0.30] },
  { keywords: ['wing', 'l', '03'],         ratio: [0.92, 0.60, 0.28] },
  { keywords: ['wing', 'r', '01'],         ratio: [0.30, 0.65, 0.35] },
  { keywords: ['wing', 'r', '02'],         ratio: [0.18, 0.68, 0.30] },
  { keywords: ['wing', 'r', '03'],         ratio: [0.08, 0.60, 0.28] },
  // Tail
  { keywords: ['tail', '01'],              ratio: [0.50, 0.52, 0.62] },
  { keywords: ['tail', '02'],              ratio: [0.50, 0.48, 0.74] },
  { keywords: ['tail', '03'],              ratio: [0.50, 0.44, 0.84] },
  { keywords: ['tail', '04'],              ratio: [0.50, 0.40, 0.92] },
]

// Kaiju (large biped)
const KAIJU_RATIOS: BoneRatioEntry[] = [
  { keywords: ['hips'],                    ratio: [0.50, 0.52, 0.50] },
  { keywords: ['spine', '01'],             ratio: [0.50, 0.60, 0.50] },
  { keywords: ['spine', '02'],             ratio: [0.50, 0.68, 0.50] },
  { keywords: ['spine', '03'],             ratio: [0.50, 0.74, 0.50] },
  { keywords: ['neck'],                    ratio: [0.50, 0.82, 0.50] },
  { keywords: ['head'],                    ratio: [0.50, 0.90, 0.50] },
  { keywords: ['upperarm_l'],              ratio: [0.65, 0.74, 0.50] },
  { keywords: ['lowerarm_l'],              ratio: [0.76, 0.62, 0.50] },
  { keywords: ['hand_l'],                  ratio: [0.85, 0.50, 0.50] },
  { keywords: ['upperarm_r'],              ratio: [0.35, 0.74, 0.50] },
  { keywords: ['lowerarm_r'],              ratio: [0.24, 0.62, 0.50] },
  { keywords: ['hand_r'],                  ratio: [0.15, 0.50, 0.50] },
  { keywords: ['thigh_l'],                 ratio: [0.57, 0.44, 0.50] },
  { keywords: ['calf_l'],                  ratio: [0.57, 0.22, 0.50] },
  { keywords: ['foot_l'],                  ratio: [0.57, 0.04, 0.50] },
  { keywords: ['thigh_r'],                 ratio: [0.43, 0.44, 0.50] },
  { keywords: ['calf_r'],                  ratio: [0.43, 0.22, 0.50] },
  { keywords: ['foot_r'],                  ratio: [0.43, 0.04, 0.50] },
  { keywords: ['tail', '01'],              ratio: [0.50, 0.50, 0.62] },
  { keywords: ['tail', '02'],              ratio: [0.50, 0.46, 0.74] },
  { keywords: ['tail', '03'],              ratio: [0.50, 0.40, 0.86] },
]

// Spider (eight-legged, low to ground)
const SPIDER_RATIOS: BoneRatioEntry[] = [
  { keywords: ['hips'],                    ratio: [0.50, 0.50, 0.55] },
  { keywords: ['spine'],                   ratio: [0.50, 0.55, 0.40] },
  { keywords: ['neck'],                    ratio: [0.50, 0.62, 0.28] },
  { keywords: ['head'],                    ratio: [0.50, 0.65, 0.20] },
  // Front pair of legs
  { keywords: ['leg', 'fl', '01'],         ratio: [0.62, 0.48, 0.25] },
  { keywords: ['leg', 'fl', '02'],         ratio: [0.72, 0.30, 0.18] },
  { keywords: ['leg', 'fl', '03'],         ratio: [0.80, 0.06, 0.14] },
  { keywords: ['leg', 'fr', '01'],         ratio: [0.38, 0.48, 0.25] },
  { keywords: ['leg', 'fr', '02'],         ratio: [0.28, 0.30, 0.18] },
  { keywords: ['leg', 'fr', '03'],         ratio: [0.20, 0.06, 0.14] },
  // Mid legs
  { keywords: ['leg', 'ml', '01'],         ratio: [0.68, 0.46, 0.45] },
  { keywords: ['leg', 'ml', '02'],         ratio: [0.80, 0.25, 0.45] },
  { keywords: ['leg', 'ml', '03'],         ratio: [0.88, 0.04, 0.44] },
  { keywords: ['leg', 'mr', '01'],         ratio: [0.32, 0.46, 0.45] },
  { keywords: ['leg', 'mr', '02'],         ratio: [0.20, 0.25, 0.45] },
  { keywords: ['leg', 'mr', '03'],         ratio: [0.12, 0.04, 0.44] },
  // Back legs
  { keywords: ['leg', 'bl', '01'],         ratio: [0.65, 0.44, 0.68] },
  { keywords: ['leg', 'bl', '02'],         ratio: [0.76, 0.22, 0.72] },
  { keywords: ['leg', 'bl', '03'],         ratio: [0.84, 0.04, 0.74] },
  { keywords: ['leg', 'br', '01'],         ratio: [0.35, 0.44, 0.68] },
  { keywords: ['leg', 'br', '02'],         ratio: [0.24, 0.22, 0.72] },
  { keywords: ['leg', 'br', '03'],         ratio: [0.16, 0.04, 0.74] },
]

// Snake (single chain along the longest axis)
const SNAKE_RATIOS: BoneRatioEntry[] = [
  { keywords: ['head'],                    ratio: [0.50, 0.50, 0.04] },
  { keywords: ['neck'],                    ratio: [0.50, 0.50, 0.12] },
  { keywords: ['spine', '01'],             ratio: [0.50, 0.50, 0.22] },
  { keywords: ['spine', '02'],             ratio: [0.50, 0.50, 0.32] },
  { keywords: ['spine', '03'],             ratio: [0.50, 0.50, 0.42] },
  { keywords: ['spine', '04'],             ratio: [0.50, 0.50, 0.52] },
  { keywords: ['spine', '05'],             ratio: [0.50, 0.50, 0.62] },
  { keywords: ['spine', '06'],             ratio: [0.50, 0.50, 0.72] },
  { keywords: ['spine', '07'],             ratio: [0.50, 0.50, 0.82] },
  { keywords: ['tail', '01'],              ratio: [0.50, 0.50, 0.88] },
  { keywords: ['tail', '02'],              ratio: [0.50, 0.50, 0.94] },
]

// Fish / shark (single chain along the horizontal axis)
const FISH_RATIOS: BoneRatioEntry[] = [
  { keywords: ['pelvis'],                  ratio: [0.50, 0.50, 0.50] },
  { keywords: ['spine', '01'],             ratio: [0.50, 0.50, 0.42] },
  { keywords: ['spine', '02'],             ratio: [0.50, 0.50, 0.32] },
  { keywords: ['spine', '03'],             ratio: [0.50, 0.50, 0.22] },
  { keywords: ['neck'],                    ratio: [0.50, 0.50, 0.14] },
  { keywords: ['head'],                    ratio: [0.50, 0.50, 0.06] },
  // Pectoral fins (sides)
  { keywords: ['fin', 'l'],               ratio: [0.72, 0.50, 0.30] },
  { keywords: ['fin', 'r'],               ratio: [0.28, 0.50, 0.30] },
  // Dorsal fin (top)
  { keywords: ['dorsal'],                  ratio: [0.50, 0.85, 0.38] },
  // Tail fin
  { keywords: ['tail'],                    ratio: [0.50, 0.50, 0.88] },
]

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find the first BoneRatioEntry whose every keyword appears as a substring of
 * the bone's lowercase name. Returns undefined when no entry matches.
 */
function find_ratio_for_bone (bone_name: string, entries: BoneRatioEntry[]): BoneRatio | undefined {
  const lower = bone_name.toLowerCase()
  for (const entry of entries) {
    if (entry.keywords.every(kw => lower.includes(kw))) {
      return entry.ratio
    }
  }
  return undefined
}

/**
 * Collect all Object3D nodes of type 'Bone' from an armature, sorted so
 * ancestor bones appear before their descendants (breadth-first).
 */
function collect_bones_breadth_first (armature: Object3D): Bone[] {
  const bones: Bone[] = []
  const queue: Object3D[] = [armature]
  while (queue.length > 0) {
    const node = queue.shift()!
    if (node.type === 'Bone') {
      bones.push(node as Bone)
    }
    node.children.forEach(child => queue.push(child))
  }
  return bones
}

// ─── AutoRigService ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AutoRigService {
  /**
   * Reposition the bones in `armature` so that they fit the bounding box of
   * `model_mesh` according to the per-skeleton placement ratios for
   * `skeleton_type`.
   *
   * @param armature   - The armature Object3D returned by StepLoadSkeleton (already cloned/scaled)
   * @param model_mesh - The loaded model whose bounding box defines the target space
   * @param skeleton_type - Which rig template to use for bone placement
   * @returns The mutated armature (same reference, modified in-place)
   */
  public static fit_to_mesh (
    armature: Object3D,
    model_mesh: Object3D,
    skeleton_type: SkeletonType
  ): Object3D {
    const ratios = AutoRigService.ratios_for_type(skeleton_type)
    if (ratios.length === 0) {
      console.warn(`AutoRigService: no placement ratios for skeleton type "${skeleton_type}", skipping auto-rig`)
      return armature
    }

    // Compute model bounding box in world space
    const bbox = new Box3().setFromObject(model_mesh)
    if (bbox.isEmpty()) {
      console.warn('AutoRigService: model bounding box is empty, skipping auto-rig')
      return armature
    }

    const bbox_size = new Vector3()
    bbox.getSize(bbox_size)

    // Process bones root-to-leaf so parent world matrices are up-to-date
    // before we compute local positions for child bones.
    armature.updateWorldMatrix(true, true)
    const bones = collect_bones_breadth_first(armature)

    for (const bone of bones) {
      const ratio = find_ratio_for_bone(bone.name, ratios)
      if (ratio === undefined) continue

      // Compute world-space target position from the ratio + bbox
      const world_target = new Vector3(
        bbox.min.x + bbox_size.x * ratio[0],
        bbox.min.y + bbox_size.y * ratio[1],
        bbox.min.z + bbox_size.z * ratio[2],
      )

      // Convert world-space target to parent-local space
      if (bone.parent !== null) {
        // Make sure parent world matrix is current
        bone.parent.updateWorldMatrix(true, false)
        const parent_world_inv = new Matrix4().copy(bone.parent.matrixWorld).invert()
        world_target.applyMatrix4(parent_world_inv)
      }

      bone.position.copy(world_target)
      // Propagate the change so downstream children see updated matrices
      bone.updateMatrixWorld(true)
    }

    return armature
  }

  private static ratios_for_type (skeleton_type: SkeletonType): BoneRatioEntry[] {
    switch (skeleton_type) {
      case SkeletonType.Human:  return HUMAN_RATIOS
      case SkeletonType.Fox:    return FOX_RATIOS
      case SkeletonType.Bird:   return BIRD_RATIOS
      case SkeletonType.Dragon: return DRAGON_RATIOS
      case SkeletonType.Kaiju:  return KAIJU_RATIOS
      case SkeletonType.Spider: return SPIDER_RATIOS
      case SkeletonType.Snake:  return SNAKE_RATIOS
      case SkeletonType.Fish:   return FISH_RATIOS
      default:                  return []
    }
  }
}
