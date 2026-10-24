"""Experimental shared vector-png Editor Core; no complete conformance claim."""
__version__ = "0.1.0.dev3"

from importlib import import_module

__all__ = ["inspect_document", "extract_source", "validate_source",
           "build_document", "verify_document", "rebuild_document"]


def __getattr__(name):
    modules = {"inspect_document": "document", "extract_source": "document", "validate_source": "svg",
               "build_document": "writing", "verify_document": "writing", "rebuild_document": "writing"}
    if name not in modules:
        raise AttributeError(name)
    value = getattr(import_module(f".{modules[name]}", __name__), name)
    globals()[name] = value
    return value
