"""Obsidian vault — Single Source of Truth per progetti cinematografici."""

from src.core.obsidian.vault_manager import ObsidianVaultManager, get_vault_manager
from src.core.obsidian.sync import schedule_obsidian_sync_from_checkpoint

__all__ = [
    "ObsidianVaultManager",
    "get_vault_manager",
    "schedule_obsidian_sync_from_checkpoint",
]
