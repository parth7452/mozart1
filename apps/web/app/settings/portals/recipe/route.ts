import type { NextRequest, NextResponse } from 'next/server';
import { PORTAL_KEY_PATTERN } from '@recouple/portal';
import {
  PortalInputError,
  PortalOwnerRequiredError,
  PortalRecipeProvenanceError,
  PortalRecipeVersionExistsError,
  PortalWriterRequiredError,
} from '@recouple/store-postgres';
import { requireSession } from '../../../../lib/session';
import { isCrossSite, refuseCrossSite } from '../../../../lib/request';
import {
  className,
  errorForLog,
  formText,
  isNamed,
  mayManagePortals,
  portalForm,
  portalNoticeFits,
  portalRedirect,
  portalStoreFor,
  portalVersionPath,
  PORTAL_SETTINGS_PATH,
  RECIPE_MAX_BYTES,
  type PortalNoticeKey,
} from '../../../../lib/portals';

/**
 * Stores a recipe version, uploaded as JSON (ADR 0057 §3). A version is
 * immutable and inert: nothing runs it but an owner's dry run until an owner
 * promotes it on its review page, where this sends them.
 *
 * `parseRecipe` is the referee, in the store: what it refuses is refused here
 * too, named by the path it refused (never by what the recipe said there). A
 * version no credential could be sealed to is refused as well, and so is one
 * whose recipe says an agent session drafted it — Settings uploads a person's
 * version only; an agent's draft arrives by its own path (ADR 0057 §5).
 *
 * Owner-only here, like everything on this page. The store would take a
 * person's version from any writer.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  const say = (notice: PortalNoticeKey, about: readonly string[] = []) =>
    portalRedirect(request, PORTAL_SETTINGS_PATH, notice, about);
  if (!mayManagePortals(session.org.role)) return say('portal_role');

  const identity = { orgId: session.org.orgId, userId: session.userId };
  const form = await portalForm(request, 'recipe upload', identity.orgId);
  if (form === undefined) return say('portal_failed');

  const file = form.get('recipe');
  if (!(file instanceof File) || file.size === 0) return say('portal_recipe_missing');
  if (file.size > RECIPE_MAX_BYTES) return say('portal_recipe_too_large');

  let recipe: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    recipe = JSON.parse(text);
  } catch {
    // Not UTF-8, or not JSON: either way not a recipe, and nothing of it is repeated.
    return say('portal_recipe_not_json');
  }

  // Uploaded from one portal's section: a recipe for another portal is a
  // mistake to say, not a version to store where nobody looked for it.
  const expected = formText(form, 'portalKey');
  const named = (recipe as { portalKey?: unknown } | null)?.portalKey;
  if (
    expected !== undefined &&
    PORTAL_KEY_PATTERN.test(expected) &&
    typeof named === 'string' &&
    named !== expected
  ) {
    return say('portal_recipe_other_portal');
  }

  const store = portalStoreFor(identity);
  try {
    if (!(await store.memberMayWrite(identity))) return say('portal_role');
    // The store runs `parseRecipe` before anything else, so an unchecked
    // value is what it is given: its refusal is the answer to a bad one.
    const recipeVersionId = await store.addRecipeVersion({
      recipe: recipe as Parameters<typeof store.addRecipeVersion>[0]['recipe'],
    });
    // Stored, so `parseRecipe` accepted these and the store checked them: they
    // are the row's own portal key and version number.
    const { portalKey, version } = recipe as { readonly portalKey: string; readonly version: number };
    console.info(
      `[recouple] portal recipe version added: version ${recipeVersionId} portal ${portalKey} ` +
        `number ${version} org ${identity.orgId} by ${identity.userId}`,
    );
    return portalRedirect(request, portalVersionPath(recipeVersionId), 'portal_recipe_added', [
      portalKey,
      String(version),
    ]);
  } catch (error) {
    const refused = recipeRefusal(error);
    if (refused !== undefined) {
      console.info(
        `[recouple] portal recipe version refused: org ${identity.orgId} by ${identity.userId} ` +
          `(${className(error)}${refused.about.length === 0 ? '' : ` at ${refused.about[0]}`})`,
      );
      return say(refused.notice, refused.about);
    }
    console.error(
      `[recouple] portal recipe version add failed: org ${identity.orgId} (${errorForLog(error)})`,
    );
    return say('portal_failed');
  }
}

/**
 * Where the first refusal was, as a path of names and indices, and never what
 * was there. Paths the notice cannot carry get the wordless refusal.
 */
function refusedAt(path: readonly PropertyKey[] | undefined): readonly string[] {
  const at = (path ?? []).map(String).join('.');
  return portalNoticeFits('portal_recipe_refused_at', [at]) ? [at] : [];
}

function recipeRefusal(
  error: unknown,
): { readonly notice: PortalNoticeKey; readonly about: readonly string[] } | undefined {
  if (isNamed(error, 'RecipeRefusedError')) {
    const issues = (error as { readonly issues?: readonly { readonly path?: readonly PropertyKey[] }[] })
      .issues;
    const about = refusedAt(issues?.[0]?.path);
    return about.length === 0
      ? { notice: 'portal_recipe_refused', about }
      : { notice: 'portal_recipe_refused_at', about };
  }
  if (isNamed(error, 'PortalBindingError')) return { notice: 'portal_recipe_unbindable', about: [] };
  if (error instanceof PortalInputError) {
    // The store's own checks past the schema: a portal key, a version number.
    const field = (error.issues[0]?.field ?? '').replace(/^recipe\./, '');
    const about = refusedAt(field === '' ? [] : field.split('.'));
    return about.length === 0
      ? { notice: 'portal_recipe_refused', about }
      : { notice: 'portal_recipe_refused_at', about };
  }
  if (error instanceof PortalRecipeProvenanceError) return { notice: 'portal_recipe_by_agent', about: [] };
  if (error instanceof PortalRecipeVersionExistsError) {
    const about = [error.portalKey, String(error.version)];
    return portalNoticeFits('portal_recipe_exists', about)
      ? { notice: 'portal_recipe_exists', about }
      : { notice: 'portal_recipe_refused', about: [] };
  }
  if (error instanceof PortalWriterRequiredError || error instanceof PortalOwnerRequiredError) {
    return { notice: 'portal_role', about: [] };
  }
  return undefined;
}
