/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorInputCapabilities, IDiffEditorInput, IResourceDiffEditorInput, IUntypedEditorInput, isEditorInput, isResourceEditorInput, isResourceDiffEditorInput, Verbosity } from '../../../common/editor.js';
import { EditorInput, IUntypedEditorOptions } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ITextEditorService } from '../../../services/textfile/common/textEditorService.js';
import { IOverlayWebview, IWebviewService } from '../../webview/browser/webview.js';
import { IWebviewWorkbenchService, LazilyResolvedWebviewEditorInput } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { WebviewIconPath } from '../../webviewPanel/browser/webviewEditorInput.js';

interface CustomEditorDiffInputInitInfo {
	readonly originalResource: URI;
	readonly modifiedResource: URI;
	readonly viewType: string;
	readonly label: string | undefined;
	readonly description: string | undefined;
	readonly iconPath: WebviewIconPath | undefined;
}

interface CustomEditorSideBySideDiffInputInitInfo extends CustomEditorDiffInputInitInfo {
	readonly diffId: string;
	readonly side: CustomEditorSideBySideDiffSide;
}

export type CustomEditorSideBySideDiffSide = 'original' | 'modified';

export class CustomEditorDiffInput extends LazilyResolvedWebviewEditorInput implements IDiffEditorInput {

	static create(
		instantiationService: IInstantiationService,
		init: CustomEditorDiffInputInitInfo,
		group: IEditorGroup | undefined,
	): CustomEditorDiffInput {
		return instantiationService.invokeFunction(accessor => {
			const textEditorService = accessor.get(ITextEditorService);
			const original = textEditorService.createTextEditor({ resource: init.originalResource });
			const modified = textEditorService.createTextEditor({ resource: init.modifiedResource });
			const webview = accessor.get(IWebviewService).createWebviewOverlay({
				providedViewType: init.viewType,
				title: init.label,
				options: {},
				contentOptions: {},
				extension: undefined,
			});

			const input = instantiationService.createInstance(CustomEditorDiffInput, init, original, modified, webview);
			if (group) {
				input.updateGroup(group.id);
			}

			return input;
		});
	}

	public static override readonly typeId = 'workbench.editors.customDiffEditor';

	constructor(
		private readonly init: CustomEditorDiffInputInitInfo,
		readonly original: EditorInput,
		readonly modified: EditorInput,
		webview: IOverlayWebview,
		@IThemeService themeService: IThemeService,
		@IWebviewWorkbenchService webviewWorkbenchService: IWebviewWorkbenchService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super({ providedId: init.viewType, viewType: init.viewType, name: init.label ?? '', iconPath: init.iconPath }, webview, themeService, webviewWorkbenchService);
	}

	override get typeId(): string {
		return CustomEditorDiffInput.typeId;
	}

	override get editorId(): string {
		return this.viewType;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton | EditorInputCapabilities.CanDropIntoEditor;
	}

	override get resource(): URI {
		return this.modifiedResource;
	}

	get originalResource(): URI {
		return this.init.originalResource;
	}

	get modifiedResource(): URI {
		return this.init.modifiedResource;
	}

	override getName(): string {
		return this.init.label ?? localize('customEditorDiffLabel', "{0} - {1}", this.original.getName(), this.modified.getName());
	}

	override getDescription(_verbosity?: Verbosity): string | undefined {
		return this.init.description ?? super.getDescription();
	}

	override getTitle(verbosity?: Verbosity): string {
		const description = this.getDescription(verbosity);
		if (description) {
			return localize('customEditorDiffTitle', "{0} ({1})", this.getName(), description);
		}

		return this.getName();
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		if (this === otherInput) {
			return true;
		}

		if (otherInput instanceof CustomEditorDiffInput) {
			return this.viewType === otherInput.viewType
				&& isEqual(this.originalResource, otherInput.originalResource)
				&& isEqual(this.modifiedResource, otherInput.modifiedResource);
		}

		if (isEditorInput(otherInput)) {
			return false;
		}

		if (isResourceDiffEditorInput(otherInput)) {
			const override = otherInput.options?.override;
			return override === this.viewType
				&& isEqual(this.originalResource, otherInput.original.resource)
				&& isEqual(this.modifiedResource, otherInput.modified.resource);
		}

		return false;
	}

	override copy(): EditorInput {
		return CustomEditorDiffInput.create(this.instantiationService, this.init, undefined);
	}

	override toUntyped(_options?: IUntypedEditorOptions): IResourceDiffEditorInput {
		return {
			original: { resource: this.originalResource },
			modified: { resource: this.modifiedResource },
			label: this.init.label,
			description: this.init.description,
			options: {
				override: this.viewType,
			}
		};
	}
}

export class CustomEditorSideBySideDiffInput extends LazilyResolvedWebviewEditorInput {

	static create(
		instantiationService: IInstantiationService,
		init: CustomEditorSideBySideDiffInputInitInfo,
		group: IEditorGroup | undefined,
	): CustomEditorSideBySideDiffInput {
		return instantiationService.invokeFunction(accessor => {
			const textEditorService = accessor.get(ITextEditorService);
			const sideInput = textEditorService.createTextEditor({ resource: init.side === 'original' ? init.originalResource : init.modifiedResource });
			const webview = accessor.get(IWebviewService).createWebviewOverlay({
				providedViewType: init.viewType,
				title: sideInput.getName(),
				options: {},
				contentOptions: {},
				extension: undefined,
			});

			const input = instantiationService.createInstance(CustomEditorSideBySideDiffInput, init, sideInput, webview);
			if (group) {
				input.updateGroup(group.id);
			}

			return input;
		});
	}

	public static override readonly typeId = 'workbench.editors.customSideBySideDiffEditor';

	constructor(
		private readonly init: CustomEditorSideBySideDiffInputInitInfo,
		private readonly sideInput: EditorInput,
		webview: IOverlayWebview,
		@IThemeService themeService: IThemeService,
		@IWebviewWorkbenchService webviewWorkbenchService: IWebviewWorkbenchService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super({ providedId: init.viewType, viewType: init.viewType, name: sideInput.getName(), iconPath: init.iconPath }, webview, themeService, webviewWorkbenchService);
	}

	override get typeId(): string {
		return CustomEditorSideBySideDiffInput.typeId;
	}

	override get editorId(): string {
		return this.viewType;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton | EditorInputCapabilities.CanDropIntoEditor;
	}

	override get resource(): URI {
		return this.side === 'original' ? this.originalResource : this.modifiedResource;
	}

	get originalResource(): URI {
		return this.init.originalResource;
	}

	get modifiedResource(): URI {
		return this.init.modifiedResource;
	}

	get side(): CustomEditorSideBySideDiffSide {
		return this.init.side;
	}

	get diffId(): string {
		return this.init.diffId;
	}

	override getName(): string {
		return this.sideInput.getName();
	}

	override getDescription(verbosity?: Verbosity): string | undefined {
		return this.sideInput.getDescription(verbosity);
	}

	override getTitle(verbosity?: Verbosity): string {
		return this.sideInput.getTitle(verbosity);
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		if (this === otherInput) {
			return true;
		}

		if (otherInput instanceof CustomEditorSideBySideDiffInput) {
			return this.editorId === otherInput.editorId
				&& this.side === otherInput.side
				&& isEqual(this.originalResource, otherInput.originalResource)
				&& isEqual(this.modifiedResource, otherInput.modifiedResource);
		}

		if (isEditorInput(otherInput)) {
			return false;
		}

		if (isResourceEditorInput(otherInput)) {
			return isEqual(this.resource, otherInput.resource);
		}

		return false;
	}

	override copy(): EditorInput {
		return CustomEditorSideBySideDiffInput.create(this.instantiationService, this.init, undefined);
	}

	override toUntyped(_options?: IUntypedEditorOptions): IUntypedEditorInput {
		return { resource: this.resource };
	}
}
