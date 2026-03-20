"use strict";
/**
 * ActionBar - Accept/Undo control for a pending notebook operation.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActionBar = void 0;
const react_1 = __importDefault(require("react"));
const ActionBar = ({ operationId, cellIndices, description, onAccept, onUndo }) => {
    const defaultDescription = `${cellIndices.length} cell${cellIndices.length !== 1 ? 's' : ''} modified`;
    return (react_1.default.createElement("div", { className: "ds-assistant-action-bar" },
        react_1.default.createElement("span", { className: "ds-assistant-action-description", title: description !== null && description !== void 0 ? description : defaultDescription }, description !== null && description !== void 0 ? description : defaultDescription),
        react_1.default.createElement("div", { className: "ds-assistant-action-buttons" },
            react_1.default.createElement("button", { className: "ds-assistant-btn ds-assistant-btn-accept", onClick: () => onAccept(operationId), title: "Accept changes" }, "Accept"),
            react_1.default.createElement("button", { className: "ds-assistant-btn ds-assistant-btn-undo", onClick: () => onUndo(operationId), title: "Undo changes" }, "Undo"))));
};
exports.ActionBar = ActionBar;
//# sourceMappingURL=ActionBar.js.map