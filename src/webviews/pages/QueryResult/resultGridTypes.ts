/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as qr from "../../../sharedInterfaces/queryResult";

// Props/handle shared by the result grid component and the grid view that hosts it. These live in
// MS's legacy `resultGrid.tsx`, which is not ported.
export interface ResultGridProps {
    gridId: string;
    gridParentRef: React.RefObject<HTMLDivElement | null>;
    resultId: number;
    batchId: number;
    viewMode?: qr.QueryResultViewMode;
    canToggleMaximize?: boolean;
    isMaximized?: boolean;
    onToggleMaximize?: () => void;
    onSelectionChange?: (hasSelection: boolean) => void;
}

export interface ResultGridHandle {
    focusGrid: () => void;
    clearSelection?: () => void;
}
