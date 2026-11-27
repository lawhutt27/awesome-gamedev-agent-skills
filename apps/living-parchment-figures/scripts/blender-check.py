import sys, bpy
path = sys.argv[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
r = bpy.ops.import_scene.gltf(filepath=path)
print('import', r)
arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
print('armatures', len(arms), 'bones', len(arms[0].data.bones) if arms else 0)
print('root bones', [b.name for b in arms[0].data.bones if b.parent is None])
for m in meshes:
    me = m.data
    print('mesh', m.name, 'verts', len(me.vertices), 'faces', len(me.polygons), 'materials', [s.material.name for s in m.material_slots])
    print('  shape keys', [k.name for k in me.shape_keys.key_blocks] if me.shape_keys else None)
    print('  vertex groups', len(m.vertex_groups), 'armature mod', [md.type for md in m.modifiers])
print('actions', sorted(a.name for a in bpy.data.actions))
# Deformation check: evaluate the mesh at rest vs with a Walk-like action applied.
import mathutils
arm = arms[0]
mesh = meshes[0]
dg = bpy.context.evaluated_depsgraph_get()
def bbox():
    ev = mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
    me = ev.to_mesh()
    zs = [(mesh.matrix_world @ v.co) for v in me.vertices]
    ev.to_mesh_clear()
    return min(v.z for v in zs), max(v.z for v in zs), min(v.x for v in zs), max(v.x for v in zs), min(v.y for v in zs), max(v.y for v in zs)
arm.animation_data_create()
print('rest bbox (zmin,zmax,xmin,xmax,ymin,ymax)', [round(x,3) for x in bbox()])
for name in ['Walk','Jump','Sit']:
    act = next((a for a in bpy.data.actions if a.name.startswith(name)), None)
    if not act: continue
    arm.animation_data.action = act
    try:
        slots = act.slots
        if len(slots): arm.animation_data.action_slot = slots[0]
    except Exception as e: pass
    bpy.context.scene.frame_set(int(act.frame_range[0] + (act.frame_range[1]-act.frame_range[0])*0.5))
    print(name, 'frames', tuple(act.frame_range), 'bbox mid', [round(x,3) for x in bbox()])
