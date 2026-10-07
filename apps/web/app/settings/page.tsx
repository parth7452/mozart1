import { redirect } from 'next/navigation';
import { SETTINGS_SECTIONS } from '../../components/workspace-shell';

/** `/settings` opens the settings panel on its first section. */
export default function SettingsIndex(): never {
  redirect(SETTINGS_SECTIONS[0]!.href);
}
