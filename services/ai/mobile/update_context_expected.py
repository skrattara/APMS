"""Print the Python-produced context fixture used by the Node parity test."""

import importlib.util
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(root / 'services' / 'ai' / 'src'))
spec = importlib.util.spec_from_file_location(
    'assessment_context_fixture',
    root / 'services' / 'ai' / 'tests' / 'test_assessment_context.py',
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
from apms_ai.assessment_context import compile_assessment_contexts

print(json.dumps(compile_assessment_contexts(module.example()), separators=(',', ':')))
