/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { IMarkdownRenderer } from '../../../../../../../platform/markdown/browser/markdownRenderer.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { localize } from '../../../../../../../nls.js';
import { IChatToolInvocation } from '../../../../common/chatService/chatService.js';
import { IChatCodeBlockInfo } from '../../../chat.js';
import { IChatContentPartRenderContext } from '../chatContentParts.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';
import { ChatToolProgressSubPart } from './chatToolProgressPart.js';
import './media/chatOtherClientToolProgress.css';

export class ChatOtherClientToolProgressPart extends BaseChatToolInvocationSubPart {
	readonly domNode: HTMLElement;
	readonly codeblocks: IChatCodeBlockInfo[] = [];

	constructor(
		toolInvocation: IChatToolInvocation,
		context: IChatContentPartRenderContext,
		renderer: IMarkdownRenderer,
		announcedToolProgressKeys: Set<string> | undefined,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(toolInvocation);

		const progressPart = this._register(instantiationService.createInstance(
			ChatToolProgressSubPart,
			toolInvocation,
			context,
			renderer,
			announcedToolProgressKeys,
		));
		this.domNode = progressPart.domNode;
		this.domNode.classList.add('chat-other-client-tool-progress');

		const skipButton = this._register(new Button(this.domNode, {
			...defaultButtonStyles,
			secondary: true,
			small: true,
		}));
		skipButton.label = localize('agentHost.otherClientTool.skip', "Skip");
		this._register(skipButton.onDidClick(() => {
			skipButton.enabled = false;
			toolInvocation.otherClientToolCall?.cancel();
		}));
	}
}
