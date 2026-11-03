"""CPU unit test for cj_subject_face_polish: two subjects, polish applied to both faces, clamp must keep
each subject's change inside its own mask and flag a drifted track."""
import importlib.util, sys
import torch

spec = importlib.util.spec_from_file_location("sfp", sys.argv[1])
sfp = importlib.util.module_from_spec(spec); spec.loader.exec_module(sfp)

B, H, W = 4, 120, 200
base = torch.zeros(B, H, W, 3)
mA = torch.zeros(B, 60, 100); mA[:, 10:55, 10:30] = 1      # subject A, left (mask at half res)
mB = torch.zeros(B, 60, 100); mB[:, 10:55, 70:90] = 1      # subject B, right
mA[0] = 0                                                   # A absent on frame 0
# seed
X, Y, f, rep = sfp.CJSubjectFaceSeed().run(mA, base, 0.002, 0.30)
print(rep)
assert f == 1 and 20 <= X <= 60 and 20 <= Y <= 40, (X, Y, f)
X2, Y2, f2, _ = sfp.CJSubjectFaceSeed().run(mB, base, 0.002, 0.30)
assert f2 == 0 and 140 <= X2 <= 180, (X2, f2)
# polish touches BOTH faces (as a drifting/confused tracker would)
pol = base.clone(); pol[:, 25:45, 25:55] = 1.0; pol[:, 25:45, 145:175] = 1.0
outA, repA = sfp.CJMaskedFaceClamp().run(base, pol, mA, 4, 2)
assert outA[1:, 25:45, 145:175].abs().max() == 0, "A's clamp leaked onto B"
assert outA[1:, 30:40, 30:50].min() > 0.99, "A's own face lost"
assert outA[0].abs().max() == 0, "A absent frame changed"
assert "max=" in repA and float(repA.split("max=")[1].split()[0]) > 0.4
# chain: B pass on top of A pass
outB, _ = sfp.CJMaskedFaceClamp().run(outA, pol, mB, 4, 2)
assert outB[:, 30:40, 150:170].min() > 0.99 and outB[1:, 30:40, 30:50].min() > 0.99
assert outB[:, 0:20].abs().max() == 0 and outB[:, :, 95:125].abs().max() == 0, "change outside both masks"
print("ALL OK")
