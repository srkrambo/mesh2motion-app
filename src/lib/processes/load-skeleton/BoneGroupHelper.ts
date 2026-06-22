import { type Object3D } from 'three'
import { type BoneGroup } from '../../RigConfig'

/**
 * Removes bones that belong to disabled optional bone groups from an armature.
 * Works similarly to HandHelper but applies to any configured group of bones.
 */
export class BoneGroupHelper {
  /**
   * Traverses the armature and removes any bones whose names match the
   * bone_name_patterns of a disabled group.
   *
   * @param armature - The root armature Object3D to modify in-place
   * @param disabled_group_ids - IDs of groups whose bones should be removed
   * @param optional_bone_groups - All available optional bone groups for this skeleton
   */
  public remove_disabled_bone_groups (
    armature: Object3D,
    disabled_group_ids: string[],
    optional_bone_groups: BoneGroup[]
  ): void {
    if (disabled_group_ids.length === 0) return

    // Collect the patterns for all disabled groups
    const disabled_patterns: string[] = []
    for (const group of optional_bone_groups) {
      if (disabled_group_ids.includes(group.id)) {
        disabled_patterns.push(...group.bone_name_patterns)
      }
    }

    if (disabled_patterns.length === 0) return

    const bones_to_remove: Object3D[] = []

    armature.traverse((child: Object3D) => {
      if (child.type !== 'Bone') return

      const bone_name_lower: string = (child.name ?? '').toLowerCase()

      if (disabled_patterns.some(pattern => bone_name_lower.includes(pattern))) {
        bones_to_remove.push(child)
      }
    })

    bones_to_remove.forEach(bone => {
      if (bone.parent != null) {
        bone.parent.remove(bone)
      }
    })
  }
}
