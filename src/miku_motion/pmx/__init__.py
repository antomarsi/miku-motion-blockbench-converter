"""PMX (MikuMikuDance model) reading: only what a motion needs from its model.

A motion file assumes its model's skeleton but doesn't contain it. From a ``.pmx`` this
package reads the bones (tree, rest positions, inherited rotations, IK chains) and the
morph names. Geometry, materials and physics are skipped and never loaded.
"""
