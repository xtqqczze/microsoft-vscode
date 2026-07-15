/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

/**
 * Prefix for the per-extension when-clause context keys that report whether an
 * extension is installed and enabled. The full key is
 * `extensionEnabled:<lowercased extension id>`, e.g. `extensionEnabled:ms-python.python`.
 *
 * Because context keys are matched by exact string, the extension id is always
 * lowercased. When clauses must therefore use the lowercased id (for example
 * `extensionEnabled:github.copilot`, not `extensionEnabled:GitHub.copilot`).
 */
export const EXTENSION_ENABLED_CONTEXT_KEY_PREFIX = 'extensionEnabled:';

/**
 * Mirrors the set of installed and enabled extensions into context keys so that
 * `when` clauses can gate on the presence of another extension without having to
 * activate it. A key `extensionEnabled:<id>` is `true` while the extension is
 * registered (installed and enabled) and `false` once it is removed (uninstalled
 * or disabled).
 */
export class ExtensionEnablementContextKeysContribution extends Disposable implements IWorkbenchContribution {

	private readonly _contextKeys = new Map<string, IContextKey<boolean>>();

	constructor(
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IExtensionService private readonly extensionService: IExtensionService,
	) {
		super();

		// Seed context keys for extensions that are already registered.
		for (const extension of this.extensionService.extensions) {
			this._setEnabled(extension.identifier, true);
		}

		// Track extensions as they get registered or de-registered.
		this._register(this.extensionService.onDidChangeExtensions(({ added, removed }) => {
			for (const extension of removed) {
				this._setEnabled(extension.identifier, false);
			}
			for (const extension of added) {
				this._setEnabled(extension.identifier, true);
			}
		}));
	}

	private _setEnabled(identifier: ExtensionIdentifier, enabled: boolean): void {
		const key = EXTENSION_ENABLED_CONTEXT_KEY_PREFIX + ExtensionIdentifier.toKey(identifier);
		let contextKey = this._contextKeys.get(key);
		if (!contextKey) {
			contextKey = this.contextKeyService.createKey<boolean>(key, false);
			this._contextKeys.set(key, contextKey);
		}
		contextKey.set(enabled);
	}
}
