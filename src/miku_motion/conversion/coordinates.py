"""Change of basis from a source coordinate space into the canonical space.

Canonical space = Blockbench model space: right-handed, Y-up, the model faces -Z and
its left side is at -X. This module is the ONLY place source axes are converted.

A basis change is an orthogonal matrix ``M`` (possibly a reflection, det = -1):

- points/offsets: ``p' = scale * M p``
- rotations: ``R' = M R M^T``. For quaternions that is ``v' = det(M) * M v`` for the
  vector part (a rotation axis is a pseudovector) with the scalar part unchanged.
"""

from dataclasses import dataclass

import numpy as np

from miku_motion.geometry.quat import ArrayLike, FloatArray


@dataclass(frozen=True, slots=True, eq=False)
class BasisChange:
    name: str
    matrix: FloatArray  # (3, 3) orthogonal

    def __post_init__(self) -> None:
        m = np.asarray(self.matrix, dtype=np.float64)
        if m.shape != (3, 3) or not np.allclose(m @ m.T, np.eye(3)):
            raise ValueError(f"basis change {self.name!r} must be an orthogonal 3x3 matrix")

    @property
    def determinant(self) -> float:
        return float(np.linalg.det(self.matrix))

    def points(self, p: ArrayLike, scale: float = 1.0) -> FloatArray:
        result: FloatArray = scale * (np.asarray(p, dtype=np.float64) @ self.matrix.T)
        return result

    def rotations(self, q: ArrayLike) -> FloatArray:
        arr = np.asarray(q, dtype=np.float64)
        vec = self.determinant * (arr[..., :3] @ self.matrix.T)
        return np.concatenate([vec, arr[..., 3:]], axis=-1)


# MikuMikuDance: left-handed, Y-up, the model faces -Z and its left side is at +X.
# Mirroring X both fixes handedness and puts the model's left at -X.
MMD_TO_CANONICAL = BasisChange("mmd", np.diag([-1.0, 1.0, 1.0]))
