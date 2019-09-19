﻿// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import * as Enums from "./enums";
import { PaddingDefinition, GlobalSettings, Versions, Version, TargetVersion, SizeAndUnit,SpacingDefinition,
    Dictionary, StringWithSubstitutions, ContentTypes, IInput, IResourceInformation, IValidationError } from "./shared";
import * as Utils from "./utils";
import * as HostConfig from "./host-config";
import * as TextFormatters from "./text-formatters";
import { HostCapabilities } from "./host-capabilities";
import { property, SerializableObject, SerializableObjectSchema, StringProperty,
    BoolProperty, ValueSetProperty, EnumProperty, SerializableObjectCollectionProperty,
    SerializableObjectProperty, PixelSizeProperty, NumProperty, PropertyBag, CustomProperty, PropertyDefinition } from "./serialization";

function isActionAllowed(action: Action, forbiddenActionTypes: string[]): boolean {
    if (forbiddenActionTypes) {
        for (let forbiddenType of forbiddenActionTypes) {
            if (action.getJsonTypeName() === forbiddenType) {
                return false;
            }
        }
    }

    return true;
}

const enum InstanceCreationErrorType {
    UnknownType,
    ForbiddenType
}

function createCardObjectInstance<T extends CardObject>(
    parent: CardElement | undefined,
    json: any,
    forbiddenTypeNames: string[],
    allowFallback: boolean,
    createInstanceCallback: (typeName: string) => T | undefined,
    createValidationErrorCallback: (typeName: string, errorType: InstanceCreationErrorType) => IValidationError,
    errors: IValidationError[] | undefined): T | undefined {
    let result: T | undefined = undefined;

    if (json && typeof json === "object") {
        let tryToFallback = false;
        let typeName = Utils.getStringValue(json["type"]);
        
        if (!Utils.isNullOrEmpty(typeName)) {
            if (forbiddenTypeNames.indexOf(<string>typeName) >= 0) {
                raiseParseError(createValidationErrorCallback(<string>typeName, InstanceCreationErrorType.ForbiddenType), errors);
            }
            else {
                result = createInstanceCallback(<string>typeName);

                if (!result) {
                    tryToFallback = allowFallback;

                    raiseParseError(createValidationErrorCallback(<string>typeName, InstanceCreationErrorType.UnknownType), errors);
                }
                else {
                    result.setParent(parent);
                    result.parse(json, errors);

                    tryToFallback = result.shouldFallback() && allowFallback;
                }

                if (tryToFallback) {
                    let fallback = json["fallback"];

                    if (!fallback && parent) {
                        parent.setShouldFallback(true);
                    }
                    if (typeof fallback === "string" && fallback.toLowerCase() === "drop") {
                        result = undefined;
                    }
                    else if (typeof fallback === "object") {
                        result = createCardObjectInstance<T>(
                            parent,
                            fallback,
                            forbiddenTypeNames,
                            true,
                            createInstanceCallback,
                            createValidationErrorCallback,
                            errors);
                    }
                }
            }
        }
    }

    return result;
}

export function createActionInstance(
    parent: CardElement,
    json: any,
    forbiddenActionTypes: string[],
    allowFallback: boolean,
    errors: IValidationError[] | undefined): Action | undefined {
    return createCardObjectInstance<Action>(
        parent,
        json,
        forbiddenActionTypes,
        allowFallback,
        (typeName: string) => { return AdaptiveCard.actionTypeRegistry.createInstance(typeName); },
        (typeName: string, errorType: InstanceCreationErrorType) => {
            if (errorType == InstanceCreationErrorType.UnknownType) {
                return {
                    error: Enums.ValidationError.UnknownActionType,
                    message: "Unknown action type: " + typeName + ". Fallback will be used if present."
                }
            }
            else {
                return {
                    error: Enums.ValidationError.ActionTypeNotAllowed,
                    message: "Action type " + typeName + " is not allowed in this context."
                }
            }
        },
        errors);
}

export function createElementInstance(
    parent: CardElement | undefined,
    json: any,
    allowFallback: boolean,
    errors: IValidationError[] | undefined): CardElement | undefined {
    return createCardObjectInstance<CardElement>(
        parent,
        json,
        [], // Forbidden types not supported for elements for now
        allowFallback,
        (typeName: string) => { return AdaptiveCard.elementTypeRegistry.createInstance(typeName); },
        (typeName: string, errorType: InstanceCreationErrorType) => {
            if (errorType == InstanceCreationErrorType.UnknownType) {
                return {
                    error: Enums.ValidationError.UnknownElementType,
                    message: "Unknown element type: " + typeName + ". Fallback will be used if present."
                }
            }
            else {
                return {
                    error: Enums.ValidationError.ElementTypeNotAllowed,
                    message: "Element type " + typeName + " is not allowed in this context."
                }
            }
        },
        errors);
}

export class ValidationFailure {
    readonly errors: IValidationError[] = [];

    constructor(readonly cardObject: CardObject) { }
}

export class ValidationResults {
    private getFailureIndex(cardObject: CardObject) {
        for (let i = 0; i < this.failures.length; i++) {
            if (this.failures[i].cardObject === cardObject) {
                return i;
            }
        }

        return -1;
    }

    readonly allIds: Dictionary<number> = {};
    readonly failures: ValidationFailure[] = [];

    addFailure(cardObject: CardObject, error: IValidationError) {
        let index = this.getFailureIndex(cardObject);
        let failure: ValidationFailure;

        if (index < 0) {
            failure = new ValidationFailure(cardObject);

            this.failures.push(failure);
        }
        else {
            failure = this.failures[index];
        }

        failure.errors.push(error);
    }
}

export abstract class CardObject extends SerializableObject {
    //#region Schema

    static readonly typeNameProperty = new StringProperty(
        Versions.v1_0,
        "type",
        undefined,
        undefined,
        undefined,
        (sender: object) => {
            return (<CardObject>sender).getJsonTypeName()
        });
    static readonly idProperty = new StringProperty(Versions.v1_0, "id");
    static readonly requiresProperty = new SerializableObjectProperty(
        Versions.v1_2,
        "requires",
        HostCapabilities);

    protected getSchemaKey(): string {
        return this.getJsonTypeName();
    }

    @property(CardObject.idProperty)
    id: string;

    @property(CardObject.requiresProperty)
    get requires(): HostCapabilities {
        return this.getValue(CardObject.requiresProperty);
    }

    //#endregion

    private _parent?: CardElement;
    private _shouldFallback: boolean = false;
    
    abstract getJsonTypeName(): string;

    abstract get hostConfig(): HostConfig.HostConfig;

    setParent(value: CardElement | undefined) {
        this._parent = value;
    }

    setShouldFallback(value: boolean) {
        this._shouldFallback = value;
    }

    shouldFallback(): boolean {
        return this._shouldFallback || !this.requires.areAllMet(this.hostConfig.hostCapabilities);
    }

    internalValidateProperties(context: ValidationResults) {
        if (!Utils.isNullOrEmpty(this.id)) {
            if (context.allIds.hasOwnProperty(this.id)) {
                if (context.allIds[this.id] == 1) {
                    context.addFailure(
                        this,
                        {
                            error: Enums.ValidationError.DuplicateId,
                            message: "Duplicate Id: " + this.id
                        });
                }

                context.allIds[this.id] += 1;
            }
            else {
                context.allIds[this.id] = 1;
            }
        }
    }

    validateProperties(): ValidationResults {
        let result = new ValidationResults();

        this.internalValidateProperties(result);

        return result;
    }

    get parent(): CardElement | undefined {
        return this._parent;
    }
}

export type CardElementHeight = "auto" | "stretch";

export abstract class CardElement extends CardObject {
    //#region Schema

    static readonly langProperty = new StringProperty(Versions.v1_1, "lang", true, /^[a-z]{2,3}$/ig);
    static readonly isVisibleProperty = new BoolProperty(Versions.v1_2, "isVisible", true);
    static readonly separatorProperty = new BoolProperty(Versions.v1_0, "separator", false);
    static readonly heightProperty = new ValueSetProperty(
        Versions.v1_1,
        "height",
        [
            { value: "auto" },
            { value: "stretch" }
        ],
        "auto");
    static readonly horizontalAlignmentProperty = new EnumProperty(
        Versions.v1_0,
        "horizontalAlignment",
        Enums.HorizontalAlignment,
        Enums.HorizontalAlignment.Left);
    static readonly spacingProperty = new EnumProperty(
        Versions.v1_0,
        "spacing",
        Enums.Spacing,
        Enums.Spacing.Default);
    static readonly minHeightProperty = new PixelSizeProperty(Versions.v1_2, "minHeight");

    protected populateSchema(schema: SerializableObjectSchema) {
        super.populateSchema(schema);

        if (!this.supportsMinHeight) {
            schema.remove(CardElement.minHeightProperty);
        }
    }

    @property(CardElement.minHeightProperty)
    minPixelHeight?: number;

    @property(CardElement.horizontalAlignmentProperty)
    horizontalAlignment: Enums.HorizontalAlignment;

    @property(CardElement.spacingProperty)
    spacing: Enums.Spacing;

    @property(CardElement.separatorProperty)
    separator: boolean;

    @property(CardElement.heightProperty)
    height: CardElementHeight;

    @property(CardElement.langProperty)
    get lang(): string | undefined {
        let lang = this.getValue(CardElement.langProperty);

        if (!Utils.isNullOrEmpty(lang)) {
            return lang;
        }
        else {
            if (this.parent) {
                return this.parent.lang;
            }
            else {
                return undefined;
            }
        }
    }

    set lang(value: string | undefined) {
        this.setValue(CardElement.langProperty, value);
    }

    @property(CardElement.isVisibleProperty)
    get isVisible(): boolean {
        return this.getValue(CardElement.isVisibleProperty);
    }

    set isVisible(value: boolean) {
        // If the element is going to be hidden, reset any changes that were due
        // to overflow truncation (this ensures that if the element is later
        // un-hidden it has the right content)
        if (GlobalSettings.useAdvancedCardBottomTruncation && !value) {
            this.undoOverflowTruncation();
        }

        if (this.isVisible !== value) {
            this.setValue(CardElement.isVisibleProperty, value);

            this.updateRenderedElementVisibility();

            if (this._renderedElement) {
                raiseElementVisibilityChangedEvent(this);
            }
        }
    }

    //#endregion

    private _hostConfig?: HostConfig.HostConfig;
    private _renderedElement?: HTMLElement;
    private _separatorElement?: HTMLElement;
    private _truncatedDueToOverflow: boolean = false;
    private _defaultRenderedElementDisplayMode: string | null = null;
    private _padding?: PaddingDefinition;

    private internalRenderSeparator(): HTMLElement | undefined {
        let renderedSeparator = Utils.renderSeparation(
            this.hostConfig,
            {
                spacing: this.hostConfig.getEffectiveSpacing(this.spacing),
                lineThickness: this.separator ? this.hostConfig.separator.lineThickness : undefined,
                lineColor: this.separator ? this.hostConfig.separator.lineColor : undefined
            },
            this.separatorOrientation);

            if (GlobalSettings.alwaysBleedSeparators && renderedSeparator && this.separatorOrientation == Enums.Orientation.Horizontal) {
                // Adjust separator's margins if the option to always bleed separators is turned on
                let parentContainer = this.getParentContainer();
    
                if (parentContainer && parentContainer.getEffectivePadding()) {
                    let parentPhysicalPadding = this.hostConfig.paddingDefinitionToSpacingDefinition(parentContainer.getEffectivePadding());
    
                    renderedSeparator.style.marginLeft = "-" + parentPhysicalPadding.left + "px";
                    renderedSeparator.style.marginRight = "-" + parentPhysicalPadding.right + "px";
                }
            }
    
            return renderedSeparator;
    }

    private updateRenderedElementVisibility() {
        let displayMode = this.isDesignMode() || this.isVisible ? this._defaultRenderedElementDisplayMode : "none";

        if (this._renderedElement) {
            this._renderedElement.style.display = displayMode;
        }

        if (this._separatorElement) {
            if (this.parent && this.parent.isFirstElement(this)) {
                this._separatorElement.style.display = "none";
            }
            else {
                this._separatorElement.style.display = displayMode;
            }
        }
    }

    private hideElementDueToOverflow() {
        if (this._renderedElement && this.isVisible) {
            this._renderedElement.style.visibility = "hidden";

            this.isVisible = false;
            raiseElementVisibilityChangedEvent(this, false);
        }
    }

    private showElementHiddenDueToOverflow() {
        if (this._renderedElement && !this.isVisible) {
            this._renderedElement.style.removeProperty("visibility");

            this.isVisible = true;
            raiseElementVisibilityChangedEvent(this, false);
        }
    }

    // Marked private to emulate internal access
    private handleOverflow(maxHeight: number) {
        if (this.isVisible || this.isHiddenDueToOverflow()) {
            let handled = this.truncateOverflow(maxHeight);

            // Even if we were unable to truncate the element to fit this time,
            // it still could have been previously truncated
            this._truncatedDueToOverflow = handled || this._truncatedDueToOverflow;

            if (!handled) {
                this.hideElementDueToOverflow();
            }
            else if (handled && !this.isVisible) {
                this.showElementHiddenDueToOverflow();
            }
        }
    }

    // Marked private to emulate internal access
    private resetOverflow(): boolean {
        let sizeChanged = false;

        if (this._truncatedDueToOverflow) {
            this.undoOverflowTruncation();
            this._truncatedDueToOverflow = false;
            sizeChanged = true;
        }

        if (this.isHiddenDueToOverflow) {
            this.showElementHiddenDueToOverflow();
        }

        return sizeChanged;
    }

    protected createPlaceholderElement(): HTMLElement {
        let styleDefinition = this.getEffectiveStyleDefinition();
        let foregroundCssColor = Utils.stringToCssColor(styleDefinition.foregroundColors.default.subtle);

        let element = document.createElement("div");
        element.style.border = "1px dashed " + foregroundCssColor;
        element.style.padding = "4px";
        element.style.minHeight = "32px";
        element.style.fontSize = "10px";
        element.style.color = <string>foregroundCssColor;
        element.innerText = "Empty " + this.getJsonTypeName();

        return element;
    }

    protected adjustRenderedElementSize(renderedElement: HTMLElement) {
        if (this.height === "auto") {
            renderedElement.style.flex = "0 0 auto";
        }
        else {
            renderedElement.style.flex = "1 1 auto";
        }

        if (this.minPixelHeight) {
            renderedElement.style.minHeight = this.minPixelHeight + "px";
        }
    }

    protected isDisplayed(): boolean {
        return this._renderedElement !== undefined && this.isVisible && this._renderedElement.offsetHeight > 0;
    }

    protected abstract internalRender(): HTMLElement | undefined;

    protected overrideInternalRender(): HTMLElement | undefined {
        return this.internalRender();
    }

    protected applyPadding() {
        if (this.separatorElement) {
            if (GlobalSettings.alwaysBleedSeparators && this.separatorOrientation == Enums.Orientation.Horizontal && !this.isBleeding()) {
                let padding = new PaddingDefinition();

                this.getImmediateSurroundingPadding(padding);

                let physicalPadding = this.hostConfig.paddingDefinitionToSpacingDefinition(padding);

                this.separatorElement.style.marginLeft = "-" + physicalPadding.left + "px";
                this.separatorElement.style.marginRight = "-" + physicalPadding.right + "px";
            }
            else {
                this.separatorElement.style.marginRight = "0";
                this.separatorElement.style.marginLeft = "0";
            }
        }
    }

    /*
     * Called when this element overflows the bottom of the card.
     * maxHeight will be the amount of space still available on the card (0 if
     * the element is fully off the card).
     */
    protected truncateOverflow(maxHeight: number): boolean {
        // Child implementations should return true if the element handled
        // the truncation request such that its content fits within maxHeight,
        // false if the element should fall back to being hidden
        return false;
    }

    /*
     * This should reverse any changes performed in truncateOverflow().
     */
    protected undoOverflowTruncation() { }

    protected getDefaultPadding(): PaddingDefinition {
        return new PaddingDefinition();
    }

    protected getHasBackground(): boolean {
        return false;
    }

    protected getPadding(): PaddingDefinition | undefined {
        return this._padding;
    }

    protected setPadding(value: PaddingDefinition | undefined) {
        this._padding = value;
    }

    protected get supportsMinHeight(): boolean {
        return false;
    }

    protected get useDefaultSizing(): boolean {
        return true;
    }

    protected get allowCustomPadding(): boolean {
        return true;
    }

    protected get separatorOrientation(): Enums.Orientation {
        return Enums.Orientation.Horizontal;
    }

    protected get defaultStyle(): string {
        return Enums.ContainerStyle.Default;
    }

    customCssSelector?: string;

    asString(): string | undefined {
        return "";
    }

    isBleeding(): boolean {
        return false;
    }

    parse(json: any, errors?: IValidationError[]) {
		super.parse(json, errors);

        raiseParseElementEvent(this, json, errors);
    }

    getEffectiveStyle(): string {
        if (this.parent) {
            return this.parent.getEffectiveStyle();
        }

        return this.defaultStyle;
    }

    getEffectiveStyleDefinition(): HostConfig.ContainerStyleDefinition {
        return this.hostConfig.containerStyles.getStyleByName(this.getEffectiveStyle());
    }

    getForbiddenElementTypes(): string[] {
        return [];
    }

    getForbiddenActionTypes(): any[] {
        return [];
    }

    getImmediateSurroundingPadding(
        result: PaddingDefinition,
        processTop: boolean = true,
        processRight: boolean = true,
        processBottom: boolean = true,
        processLeft: boolean = true) {
        if (this.parent) {
            let doProcessTop = processTop && this.parent.isTopElement(this);
            let doProcessRight = processRight && this.parent.isRightMostElement(this);
            let doProcessBottom = processBottom && this.parent.isBottomElement(this);
            let doProcessLeft = processLeft && this.parent.isLeftMostElement(this);

            let effectivePadding = this.parent.getEffectivePadding();

            if (effectivePadding) {
                if (doProcessTop && effectivePadding.top != Enums.Spacing.None) {
                    result.top = effectivePadding.top;

                    doProcessTop = false;
                }

                if (doProcessRight && effectivePadding.right != Enums.Spacing.None) {
                    result.right = effectivePadding.right;

                    doProcessRight = false;
                }

                if (doProcessBottom && effectivePadding.bottom != Enums.Spacing.None) {
                    result.bottom = effectivePadding.bottom;

                    doProcessBottom = false;
                }

                if (doProcessLeft && effectivePadding.left != Enums.Spacing.None) {
                    result.left = effectivePadding.left;

                    doProcessLeft = false;
                }
            }

            if (doProcessTop || doProcessRight || doProcessBottom || doProcessLeft) {
                this.parent.getImmediateSurroundingPadding(
                    result,
                    doProcessTop,
                    doProcessRight,
                    doProcessBottom,
                    doProcessLeft);
            }
        }
    }

    getActionCount(): number {
        return 0;
    }

    getActionAt(index: number): Action | undefined {
        throw new Error("Index out of range.");
    }

    remove(): boolean {
        if (this.parent && this.parent instanceof CardElementContainer) {
            return this.parent.removeItem(this);
        }

        return false;
    }

    render(): HTMLElement | undefined {
        this._renderedElement = this.overrideInternalRender();
        this._separatorElement = this.internalRenderSeparator();

        if (this._renderedElement) {
            if (this.customCssSelector) {
                this._renderedElement.classList.add(this.customCssSelector);
            }

            this._renderedElement.style.boxSizing = "border-box";
            this._defaultRenderedElementDisplayMode = this._renderedElement.style.display;

            this.adjustRenderedElementSize(this._renderedElement);
            this.updateLayout(false);
        }
        else if (this.isDesignMode()) {
            this._renderedElement = this.createPlaceholderElement();
        }

        return this._renderedElement;
    }

    updateLayout(processChildren: boolean = true) {
        this.updateRenderedElementVisibility();
        this.applyPadding();
    }

    indexOf(cardElement: CardElement): number {
        return -1;
    }

    isDesignMode(): boolean {
        let rootElement = this.getRootElement();

        return rootElement instanceof AdaptiveCard && rootElement.designMode;
    }

    isFirstElement(element: CardElement): boolean {
        return true;
    }

    isLastElement(element: CardElement): boolean {
        return true;
    }

    isAtTheVeryLeft(): boolean {
        return this.parent ? this.parent.isLeftMostElement(this) && this.parent.isAtTheVeryLeft() : true;
    }

    isAtTheVeryRight(): boolean {
        return this.parent ? this.parent.isRightMostElement(this) && this.parent.isAtTheVeryRight() : true;
    }

    isAtTheVeryTop(): boolean {
        return this.parent ? this.parent.isFirstElement(this) && this.parent.isAtTheVeryTop() : true;
    }

    isAtTheVeryBottom(): boolean {
        return this.parent ? this.parent.isLastElement(this) && this.parent.isAtTheVeryBottom() : true;
    }

    isBleedingAtTop(): boolean {
        return false;
    }

    isBleedingAtBottom(): boolean {
        return false;
    }

    isLeftMostElement(element: CardElement): boolean {
        return true;
    }

    isRightMostElement(element: CardElement): boolean {
        return true;
    }

    isTopElement(element: CardElement): boolean {
        return this.isFirstElement(element);
    }

    isBottomElement(element: CardElement): boolean {
        return this.isLastElement(element);
    }

    isHiddenDueToOverflow(): boolean {
        return this._renderedElement !== undefined && this._renderedElement.style.visibility == 'hidden';
    }

    getRootElement(): CardElement {
        let rootElement: CardElement = this;

        while (rootElement.parent) {
            rootElement = rootElement.parent;
        }

        return rootElement;
    }

    getParentContainer(): Container | undefined {
        let currentElement = this.parent;

        while (currentElement) {
            if (currentElement instanceof Container) {
                return <Container>currentElement;
            }

            currentElement = currentElement.parent;
        }

        return undefined;
    }

    getAllInputs(): Input[] {
        return [];
    }

    getResourceInformation(): IResourceInformation[] {
        return [];
    }

    getElementById(id: string): CardElement | undefined {
        return this.id === id ? this : undefined;
    }

    getActionById(id: string): Action | undefined {
        return undefined;
    }

    getEffectivePadding(): PaddingDefinition {
        let padding = this.getPadding();

        return (padding && this.allowCustomPadding) ? padding : this.getDefaultPadding();
    }

    get hostConfig(): HostConfig.HostConfig {
        if (this._hostConfig) {
            return this._hostConfig;
        }
        else {
            if (this.parent) {
                return this.parent.hostConfig;
            }
            else {
                return defaultHostConfig;
            }
        }
    }

    set hostConfig(value: HostConfig.HostConfig) {
        this._hostConfig = value;
    }

    get index(): number {
        if (this.parent) {
            return this.parent.indexOf(this);
        }
        else {
            return 0;
        }
    }

    get isInteractive(): boolean {
        return false;
    }

    get isStandalone(): boolean {
        return true;
    }

    get isInline(): boolean {
        return false;
    }

    get hasVisibleSeparator(): boolean {
        if (this.parent && this.separatorElement) {
            return !this.parent.isFirstElement(this) && (this.isVisible || this.isDesignMode());
        }
        else {
            return false;
        }
    }

    get renderedElement(): HTMLElement | undefined {
        return this._renderedElement;
    }

    get separatorElement(): HTMLElement | undefined {
        return this._separatorElement;
    }
}

export class ActionPropertyDefinition extends PropertyDefinition {
    parse(sender: SerializableObject, source: PropertyBag, errors?: IValidationError[]): Action | undefined {
        let parent = <CardElement>sender;

        return createActionInstance(
            parent,
            source[this.name],
            this.forbiddenActionTypes,
            parent.isDesignMode(),
            errors);
    }

    toJSON(sender: SerializableObject, target: PropertyBag, value: Action | undefined) {
        Utils.setProperty(target, this.name, value ? value.toJSON() : undefined);
    }

    constructor(
        readonly targetVersion: TargetVersion,
        readonly name: string,
        readonly forbiddenActionTypes: string[] = []) {
        super(targetVersion, name, undefined);
    }
}

export abstract class BaseTextBlock extends CardElement {
    //#region Schema

    static readonly textProperty = new StringProperty(
        Versions.v1_0,
        "text",
        true);
    static readonly sizeProperty = new EnumProperty(
        Versions.v1_0,
        "size",
        Enums.TextSize,
        Enums.TextSize.Default);
    static readonly weightProperty = new EnumProperty(
        Versions.v1_0,
        "weight",
        Enums.TextWeight,
        Enums.TextWeight.Default);
    static readonly colorProperty = new EnumProperty(
        Versions.v1_0,
        "color",
        Enums.TextColor,
        Enums.TextColor.Default);
    static readonly isSubtleProperty = new BoolProperty(
        Versions.v1_0,
        "isSubtle",
        false);
    static readonly fontTypeProperty = new EnumProperty(
        Versions.v1_2,
        "fontType",
        Enums.FontType);
    static readonly selectActionProperty = new ActionPropertyDefinition(Versions.v1_0, "selectAction", [ "Action.ShowCard" ]);

    protected populateSchema(schema: SerializableObjectSchema) {
        super.populateSchema(schema);

        // selectAction is declared on BaseTextBlock but is only exposed on TextRun,
        // so the property is removed from the BaseTextBlock schema.
        schema.remove(BaseTextBlock.selectActionProperty);        
    }

    @property(BaseTextBlock.sizeProperty)
    size: Enums.TextSize = Enums.TextSize.Default;

    @property(BaseTextBlock.weightProperty)
    weight: Enums.TextWeight = Enums.TextWeight.Default;

    @property(BaseTextBlock.colorProperty)
    color: Enums.TextColor = Enums.TextColor.Default;

    @property(BaseTextBlock.fontTypeProperty)
    fontType?: Enums.FontType;

    @property(BaseTextBlock.isSubtleProperty)
    isSubtle: boolean = false;

    @property(BaseTextBlock.textProperty)
    get text(): string | undefined {
        return this.getValue(BaseTextBlock.textProperty);
    }

    set text(value: string | undefined) {
        this.setText(value);
    }

    @property(BaseTextBlock.selectActionProperty)
    selectAction?: Action;

    //#endregion

    protected getFontSize(fontType: HostConfig.FontTypeDefinition): number {
        switch (this.size) {
            case Enums.TextSize.Small:
                return fontType.fontSizes.small;
            case Enums.TextSize.Medium:
                return fontType.fontSizes.medium;
            case Enums.TextSize.Large:
                return fontType.fontSizes.large;
            case Enums.TextSize.ExtraLarge:
                return fontType.fontSizes.extraLarge;
            default:
                return fontType.fontSizes.default;
        }
    }

    protected getColorDefinition(colorSet: HostConfig.ColorSetDefinition, color: Enums.TextColor): HostConfig.TextColorDefinition {
        switch (color) {
            case Enums.TextColor.Accent:
                return colorSet.accent;
            case Enums.TextColor.Dark:
                return colorSet.dark;
            case Enums.TextColor.Light:
                return colorSet.light;
            case Enums.TextColor.Good:
                return colorSet.good;
            case Enums.TextColor.Warning:
                return colorSet.warning;
            case Enums.TextColor.Attention:
                return colorSet.attention;
            default:
                return colorSet.default;
        }
    }

    protected setText(value: string | undefined) {
        this.setValue(BaseTextBlock.textProperty, value);
    }

    asString(): string | undefined {
        return this.text;
    }

    applyStylesTo(targetElement: HTMLElement) {
        let fontType = this.hostConfig.getFontTypeDefinition(this.fontType);

        if (fontType.fontFamily) {
            targetElement.style.fontFamily = fontType.fontFamily;
        }

        let fontSize: number;

        switch (this.size) {
            case Enums.TextSize.Small:
                fontSize = fontType.fontSizes.small;
                break;
            case Enums.TextSize.Medium:
                fontSize = fontType.fontSizes.medium;
                break;
            case Enums.TextSize.Large:
                fontSize = fontType.fontSizes.large;
                break;
            case Enums.TextSize.ExtraLarge:
                fontSize = fontType.fontSizes.extraLarge;
                break;
            default:
                fontSize = fontType.fontSizes.default;
                break;
        }

        targetElement.style.fontSize = fontSize + "px";

        let colorDefinition = this.getColorDefinition(this.getEffectiveStyleDefinition().foregroundColors, this.effectiveColor);

        targetElement.style.color = <string>Utils.stringToCssColor(this.isSubtle ? colorDefinition.subtle : colorDefinition.default);

        let fontWeight: number;

        switch (this.weight) {
            case Enums.TextWeight.Lighter:
                fontWeight = fontType.fontWeights.lighter;
                break;
            case Enums.TextWeight.Bolder:
                fontWeight = fontType.fontWeights.bolder;
                break;
            default:
                fontWeight = fontType.fontWeights.default;
                break;
        }

        targetElement.style.fontWeight = fontWeight.toString();
    }

    get effectiveColor(): Enums.TextColor {
        return this.color ? this.color : Enums.TextColor.Default;
    }
}

export class TextBlock extends BaseTextBlock {
    //#region Schema

    static readonly wrapProperty = new BoolProperty(Versions.v1_0, "wrap", false);
    static readonly maxLinesProperty = new NumProperty(Versions.v1_0, "maxLines");

    @property(TextBlock.wrapProperty)
    wrap: boolean = false;

    @property(TextBlock.maxLinesProperty)
    maxLines?: number;

    //#endregion

    private _computedLineHeight: number;
    private _originalInnerHtml: string;
    private _processedText?: string;
    private _treatAsPlainText: boolean = true;

    private restoreOriginalContent() {
        if (this.renderedElement !== undefined) {
            this.renderedElement.style.maxHeight = (this.maxLines && this.maxLines > 0) ? (this._computedLineHeight * this.maxLines) + 'px' : null;
            this.renderedElement.innerHTML = this._originalInnerHtml;
        }
    }

    private truncateIfSupported(maxHeight: number): boolean {
        if (this.renderedElement !== undefined) {
            // For now, only truncate TextBlocks that contain just a single
            // paragraph -- since the maxLines calculation doesn't take into
            // account Markdown lists
            let children = this.renderedElement.children;
            let isTextOnly = !children.length;
            let truncationSupported = isTextOnly || children.length == 1 && (<HTMLElement>children[0]).tagName.toLowerCase() == 'p';

            if (truncationSupported) {
                let element = isTextOnly ? this.renderedElement : <HTMLElement>children[0];

                Utils.truncate(element, maxHeight, this._computedLineHeight);

                return true;
            }
        }

        return false;
    }

    protected setText(value: string) {
        super.setText(value);

        this._processedText = undefined;
    }

    protected getRenderedDomElementType(): string {
        return "div";
    }

    protected internalRender(): HTMLElement | undefined {
        this._processedText = undefined;

        if (!Utils.isNullOrEmpty(this.text)) {
            let hostConfig = this.hostConfig;

            let element = document.createElement(this.getRenderedDomElementType());
            element.classList.add(hostConfig.makeCssClassName("ac-textBlock"));
            element.style.overflow = "hidden";

            this.applyStylesTo(element);

            if (this.selectAction) {
                element.onclick = (e) => {
                    e.preventDefault();
                    e.cancelBubble = true;

                    if (this.selectAction) {
                        this.selectAction.execute();
                    }
                }

                if (hostConfig.supportsInteractivity) {
                    element.tabIndex = 0
                    element.setAttribute("role", "button");

                    if (!Utils.isNullOrEmpty(this.selectAction.title)) {
                        element.setAttribute("aria-label", <string>this.selectAction.title);
                    }

                    element.classList.add(hostConfig.makeCssClassName("ac-selectable"));
                }
            }

            if (!this._processedText) {
                this._treatAsPlainText = true;

                let formattedText = TextFormatters.formatText(this.lang, this.text);

                if (this.useMarkdown && formattedText) {
                    if (GlobalSettings.allowMarkForTextHighlighting) {
                        formattedText = formattedText.replace(/<mark>/g, "===").replace(/<\/mark>/g, "/==");
                    }

                    let markdownProcessingResult = AdaptiveCard.applyMarkdown(formattedText);

                    if (markdownProcessingResult.didProcess && markdownProcessingResult.outputHtml) {
                        this._processedText = markdownProcessingResult.outputHtml;
                        this._treatAsPlainText = false;

                        // Only process <mark> tag if markdown processing was applied because
                        // markdown processing is also responsible for sanitizing the input string
                        if (GlobalSettings.allowMarkForTextHighlighting && this._processedText) {
                            let markStyle: string = "";
                            let effectiveStyle = this.getEffectiveStyleDefinition();

                            if (effectiveStyle.highlightBackgroundColor) {
                                markStyle += "background-color: " + effectiveStyle.highlightBackgroundColor + ";";
                            }

                            if (effectiveStyle.highlightForegroundColor) {
                                markStyle += "color: " + effectiveStyle.highlightForegroundColor + ";";
                            }

                            if (!Utils.isNullOrEmpty(markStyle)) {
                                markStyle = 'style="' + markStyle + '"';
                            }

                            this._processedText = this._processedText.replace(/===/g, "<mark " + markStyle + ">").replace(/\/==/g, "</mark>");
                        }
                    } else {
                        this._processedText = formattedText;
                        this._treatAsPlainText = true;
                    }
                }
                else {
                    this._processedText = formattedText;
                    this._treatAsPlainText = true;
                }
            }

            if (!this._processedText) {
                this._processedText = "";
            }

            if (this._treatAsPlainText) {
                element.innerText = this._processedText;
            }
            else {
                element.innerHTML = this._processedText;
            }

            if (element.firstElementChild instanceof HTMLElement) {
                let firstElementChild = <HTMLElement>element.firstElementChild;
                firstElementChild.style.marginTop = "0px";
                firstElementChild.style.width = "100%";

                if (!this.wrap) {
                    firstElementChild.style.overflow = "hidden";
                    firstElementChild.style.textOverflow = "ellipsis";
                }
            }

            if (element.lastElementChild instanceof HTMLElement) {
                (<HTMLElement>element.lastElementChild).style.marginBottom = "0px";
            }

            let anchors = element.getElementsByTagName("a");

            for (let i = 0; i < anchors.length; i++) {
                let anchor = <HTMLAnchorElement>anchors[i];
                anchor.classList.add(hostConfig.makeCssClassName("ac-anchor"));
                anchor.target = "_blank";
                anchor.onclick = (e) => {
                    if (raiseAnchorClickedEvent(this, e.target as HTMLAnchorElement)) {
                        e.preventDefault();
                        e.cancelBubble = true;
                    }
                }
            }

            if (this.wrap) {
                element.style.wordWrap = "break-word";

                if (this.maxLines && this.maxLines > 0) {
                    element.style.maxHeight = (this._computedLineHeight * this.maxLines) + "px";
                    element.style.overflow = "hidden";
                }
            }
            else {
                element.style.whiteSpace = "nowrap";
                element.style.textOverflow = "ellipsis";
            }

            if (GlobalSettings.useAdvancedTextBlockTruncation || GlobalSettings.useAdvancedCardBottomTruncation) {
                this._originalInnerHtml = element.innerHTML;
            }

            return element;
        }
        else {
            return undefined;
        }
    }

    protected truncateOverflow(maxHeight: number): boolean {
        if (maxHeight >= this._computedLineHeight) {
            return this.truncateIfSupported(maxHeight);
        }

        return false;
    }

    protected undoOverflowTruncation() {
        this.restoreOriginalContent();

        if (GlobalSettings.useAdvancedTextBlockTruncation && this.maxLines) {
            let maxHeight = this._computedLineHeight * this.maxLines;

            this.truncateIfSupported(maxHeight);
        }
    }

    useMarkdown: boolean = true;

    applyStylesTo(targetElement: HTMLElement) {
        super.applyStylesTo(targetElement);

        let parentContainer = this.getParentContainer();
        let isRtl = parentContainer ? parentContainer.isRtl() : false;

        switch (this.horizontalAlignment) {
            case Enums.HorizontalAlignment.Center:
                targetElement.style.textAlign = "center";
                break;
            case Enums.HorizontalAlignment.Right:
                targetElement.style.textAlign = isRtl ? "left" : "right";
                break;
            default:
                targetElement.style.textAlign = isRtl ? "right" : "left";
                break;
        }

        let lineHeights = this.hostConfig.lineHeights;

        if (lineHeights) {
            switch (this.size) {
                case Enums.TextSize.Small:
                    this._computedLineHeight = lineHeights.small;
                    break;
                case Enums.TextSize.Medium:
                    this._computedLineHeight = lineHeights.medium;
                    break;
                case Enums.TextSize.Large:
                    this._computedLineHeight = lineHeights.large;
                    break;
                case Enums.TextSize.ExtraLarge:
                    this._computedLineHeight = lineHeights.extraLarge;
                    break;
                default:
                    this._computedLineHeight = lineHeights.default;
                    break;
            }
        }
        else {
            // Looks like 1.33 is the magic number to compute line-height
            // from font size.
            this._computedLineHeight = this.getFontSize(this.hostConfig.getFontTypeDefinition(this.fontType)) * 1.33;
        }

        targetElement.style.lineHeight = this._computedLineHeight + "px";
    }

    getJsonTypeName(): string {
        return "TextBlock";
    }

    updateLayout(processChildren: boolean = false) {
        super.updateLayout(processChildren);

        if (GlobalSettings.useAdvancedTextBlockTruncation && this.maxLines && this.isDisplayed()) {
            // Reset the element's innerHTML in case the available room for
            // content has increased
            this.restoreOriginalContent();
            this.truncateIfSupported(this._computedLineHeight * this.maxLines);
        }
    }
}

class Label extends TextBlock {
    protected getRenderedDomElementType(): string {
        return "label";
    }

    protected internalRender(): HTMLElement | undefined {
        let renderedElement = <HTMLLabelElement>super.internalRender();

        if (!Utils.isNullOrEmpty(this.forElementId)) {
            renderedElement.htmlFor = this.forElementId;
        }

        return renderedElement;
    }

    forElementId: string;
}

export class TextRun extends BaseTextBlock {
    //#region Schema

    static readonly italicProperty = new BoolProperty(Versions.v1_2, "italic", false);
    static readonly strikethroughProperty = new BoolProperty(Versions.v1_2, "strikethrough", false);
    static readonly highlightProperty = new BoolProperty(Versions.v1_2, "highlight", false);

    protected populateSchema(schema: SerializableObjectSchema) {
        super.populateSchema(schema);

        schema.add(BaseTextBlock.selectActionProperty);
    }

    @property(TextRun.italicProperty)
    italic: boolean = false;

    @property(TextRun.strikethroughProperty)
    strikethrough: boolean = false;

    @property(TextRun.highlightProperty)
    highlight: boolean = false;

    //#endregion

    protected internalRender(): HTMLElement | undefined {
        if (!Utils.isNullOrEmpty(this.text)) {
            let hostConfig = this.hostConfig;

            let formattedText = TextFormatters.formatText(this.lang, this.text);

            if (!formattedText) {
                formattedText = "";
            }

            let element = document.createElement("span");
            element.classList.add(hostConfig.makeCssClassName("ac-textRun"));

            this.applyStylesTo(element);

            if (this.selectAction && hostConfig.supportsInteractivity) {
                let anchor = document.createElement("a");
                anchor.classList.add(hostConfig.makeCssClassName("ac-anchor"));

                let href = this.selectAction.getHref();

                if (!Utils.isNullOrEmpty(href)) {
                    anchor.href = <string>href;
                }

                anchor.target = "_blank";
                anchor.onclick = (e) => {
                    e.preventDefault();
                    e.cancelBubble = true;

                    if (this.selectAction) {
                        this.selectAction.execute();
                    }
                }

                anchor.innerText = formattedText;

                element.appendChild(anchor);
            }
            else {
                element.innerText = formattedText;
            }

            return element;
        }
        else {
            return undefined;
        }
    }

    applyStylesTo(targetElement: HTMLElement) {
        super.applyStylesTo(targetElement);

        if (this.italic) {
            targetElement.style.fontStyle = "italic";
        }

        if (this.strikethrough) {
            targetElement.style.textDecoration = "line-through";
        }

        if (this.highlight) {
            let colorDefinition = this.getColorDefinition(this.getEffectiveStyleDefinition().foregroundColors, this.effectiveColor);

            targetElement.style.backgroundColor = <string>Utils.stringToCssColor(this.isSubtle ? colorDefinition.highlightColors.subtle : colorDefinition.highlightColors.default);
        }
    }

    getJsonTypeName(): string {
        return "TextRun";
    }

    get isStandalone(): boolean {
        return false;
    }

    get isInline(): boolean {
        return true;
    }
}

export class RichTextBlock extends CardElement {
    private _inlines: CardElement[] = [];

    private internalAddInline(inline: CardElement, forceAdd: boolean = false) {
        if (!inline.isInline) {
            throw new Error("RichTextBlock.addInline: the specified card element cannot be used as a RichTextBlock inline.");
        }

        let doAdd: boolean = inline.parent === undefined || forceAdd;

        if (!doAdd && inline.parent != this) {
            throw new Error("RichTextBlock.addInline: the specified inline already belongs to another RichTextBlock.");
        }
        else {
            inline.setParent(this);

            this._inlines.push(inline);
        }
    }

    protected internalRender(): HTMLElement | undefined {
        if (this._inlines.length > 0) {
            let element = document.createElement("div");
            element.className = this.hostConfig.makeCssClassName("ac-richTextBlock");

            let parentContainer = this.getParentContainer();
            let isRtl = parentContainer ? parentContainer.isRtl() : false;

            switch (this.horizontalAlignment) {
                case Enums.HorizontalAlignment.Center:
                    element.style.textAlign = "center";
                    break;
                case Enums.HorizontalAlignment.Right:
                    element.style.textAlign = isRtl ? "left" : "right";
                    break;
                default:
                    element.style.textAlign = isRtl ? "right" : "left";
                    break;
            }

            for (let inline of this._inlines) {
                let renderedInline = inline.render();

                if (renderedInline) {
                    element.appendChild(renderedInline);
                }
            }

            return element;
        }
        else {
            return undefined;
        }
    }

    asString(): string | undefined {
        let result = "";

        for (let inline of this._inlines) {
            result += inline.asString();
        }

        return result;
    }

    parse(json: any, errors?: IValidationError[]) {
        super.parse(json, errors);

        this._inlines = [];

        if (Array.isArray(json["inlines"])) {
            for (let jsonInline of json["inlines"]) {
                let inline: CardElement | undefined;

                if (typeof jsonInline === "string") {
                    let textRun = new TextRun();
                    textRun.text = jsonInline;

                    inline = textRun;
                }
                else {
                    inline = createElementInstance(
                        this,
                        jsonInline,
                        false, // No fallback for inlines in 1.2
                        errors);
                }

                if (inline) {
                    this.internalAddInline(inline, true);
                }
            }
        }
    }

    toJSON() {
        let result = super.toJSON();

        if (this._inlines.length > 0) {
            let jsonInlines: any[] = [];

            for (let inline of this._inlines) {
                jsonInlines.push(inline.toJSON());
            }

            Utils.setProperty(result, "inlines", jsonInlines);
        }

        return result;
    }

    getJsonTypeName(): string {
        return "RichTextBlock";
    }

    getInlineCount(): number {
        return this._inlines.length;
    }

    getInlineAt(index: number): CardElement {
        if (index >= 0 && index < this._inlines.length) {
            return this._inlines[index];
        }
        else {
            throw new Error("RichTextBlock.getInlineAt: Index out of range (" + index + ")");
        }
    }

    addInline(inline: CardElement) {
        this.internalAddInline(inline);
    }

    removeInline(inline: CardElement): boolean {
        let index = this._inlines.indexOf(inline);

        if (index >= 0) {
            this._inlines[index].setParent(undefined);
            this._inlines.splice(index, 1);

            return true;
        }

        return false;
    }
}

export class Fact extends SerializableObject {
    //#region Schema

    static readonly titleProperty = new StringProperty(Versions.v1_0, "title");
    static readonly valueProperty = new StringProperty(Versions.v1_0, "value");

    // For historic reasons, the "title" schema property is exposed as "name" in the OM.
    @property(Fact.titleProperty)
    name?: string;

    @property(Fact.valueProperty)
    value?: string;

    //#endregion

    protected getSchemaKey(): string {
        return "Fact";
    }

    constructor(name?: string, value?: string) {
        super();

        this.name = name;
        this.value = value;
    }
}

export class FactSet extends CardElement {
    //#region Schema

    static readonly factsProperty = new SerializableObjectCollectionProperty<Fact>(
        Versions.v1_0,
        "facts",
        (sourceItem: any) => { return new Fact(); },
        (sender: object) => { return []; });

    @property(FactSet.factsProperty)
    facts: Fact[];

    //#endregion

    protected get useDefaultSizing(): boolean {
        return false;
    }

    protected internalRender(): HTMLElement | undefined {
        let element: HTMLElement | undefined = undefined;
        let hostConfig = this.hostConfig;

        if (this.facts.length > 0) {
            element = document.createElement("table");
            element.style.borderWidth = "0px";
            element.style.borderSpacing = "0px";
            element.style.borderStyle = "none";
            element.style.borderCollapse = "collapse";
            element.style.display = "block";
            element.style.overflow = "hidden";
            element.classList.add(hostConfig.makeCssClassName("ac-factset"));

            for (let i = 0; i < this.facts.length; i++) {
                let trElement = document.createElement("tr");

                if (i > 0) {
                    trElement.style.marginTop = hostConfig.factSet.spacing + "px";
                }

                // Title column
                let tdElement = document.createElement("td");
                tdElement.style.padding = "0";
                tdElement.classList.add(hostConfig.makeCssClassName("ac-fact-title"));

                if (hostConfig.factSet.title.maxWidth) {
                    tdElement.style.maxWidth = hostConfig.factSet.title.maxWidth + "px";
                }

                tdElement.style.verticalAlign = "top";

                let textBlock = new TextBlock();
                textBlock.setParent(this);
                textBlock.text = Utils.isNullOrEmpty(this.facts[i].name) ? "Title" : this.facts[i].name;
                textBlock.size = hostConfig.factSet.title.size;
                textBlock.color = hostConfig.factSet.title.color;
                textBlock.isSubtle = hostConfig.factSet.title.isSubtle;
                textBlock.weight = hostConfig.factSet.title.weight;
                textBlock.wrap = hostConfig.factSet.title.wrap;
                textBlock.spacing = Enums.Spacing.None;

                Utils.appendChild(tdElement, textBlock.render());
                Utils.appendChild(trElement, tdElement);

                // Spacer column
                tdElement = document.createElement("td");
                tdElement.style.width = "10px";

                Utils.appendChild(trElement, tdElement);

                // Value column
                tdElement = document.createElement("td");
                tdElement.style.padding = "0";
                tdElement.style.verticalAlign = "top";
                tdElement.classList.add(hostConfig.makeCssClassName("ac-fact-value"));

                textBlock = new TextBlock();
                textBlock.setParent(this);
                textBlock.text = this.facts[i].value;
                textBlock.size = hostConfig.factSet.value.size;
                textBlock.color = hostConfig.factSet.value.color;
                textBlock.isSubtle = hostConfig.factSet.value.isSubtle;
                textBlock.weight = hostConfig.factSet.value.weight;
                textBlock.wrap = hostConfig.factSet.value.wrap;
                textBlock.spacing = Enums.Spacing.None;

                Utils.appendChild(tdElement, textBlock.render());
                Utils.appendChild(trElement, tdElement);
                Utils.appendChild(element, trElement);
            }
        }

        return element;
    }

    getJsonTypeName(): string {
        return "FactSet";
    }
}

class ImageDimensionProperty extends PropertyDefinition {
    getJsonPropertyName(): string {
        return this.jsonName;
    }
    
    parse(sender: SerializableObject, source: PropertyBag, errors?: IValidationError[]): number | undefined {
        let result: number | undefined = undefined;
        let value = source[this.jsonName];

        if (typeof value === "string") {
            let isValid = false;

            try {
                let size = SizeAndUnit.parse(value, true);

                if (size.unit == Enums.SizeUnit.Pixel) {
                    result = size.physicalSize;

                    isValid = true;
                }
            }
            catch {
                // Do nothing. A parse error is emitted below
            }

            if (!isValid) {
                raiseParseError(
                    {
                        error: Enums.ValidationError.InvalidPropertyValue,
                        message: "Invalid " + this.name + " value: " + value
                    },
                    errors
                );
            }
        }

        return result;
    }

    toJSON(sender: SerializableObject, target: PropertyBag, value: number | undefined) {
        Utils.setProperty(
            target,
            this.jsonName,
            typeof value === "number" && !isNaN(value) ? value + "px" : undefined);
    }

    constructor(
        readonly targetVersion: TargetVersion,
        readonly name: string,
        readonly jsonName: string) {
        super(targetVersion, name);
    }
}

export class Image extends CardElement {
    //#region Schema

    static readonly urlProperty = new StringProperty(Versions.v1_0, "url");
    static readonly altTextProperty = new StringProperty(Versions.v1_0, "altText");
    static readonly backgroundColorProperty = new StringProperty(Versions.v1_1, "backgroundColor");
    static readonly styleProperty = new EnumProperty(
        Versions.v1_0,
        "style",
        Enums.ImageStyle,
        Enums.ImageStyle.Default);
    static readonly sizeProperty = new EnumProperty(
        Versions.v1_0,
        "size",
        Enums.Size,
        Enums.Size.Auto);
    static readonly pixelWidthProperty = new ImageDimensionProperty(Versions.v1_1, "pixelWidth", "width");
    static readonly pixelHeightProperty = new ImageDimensionProperty(Versions.v1_1, "pixelHeight", "height");
    static readonly selectActionProperty = new ActionPropertyDefinition(Versions.v1_0, "selectAction", [ "Action.ShowCard" ]);

    @property(Image.urlProperty)
    url?: string;

    @property(Image.altTextProperty)
    altText?: string;

    @property(Image.backgroundColorProperty)
    backgroundColor?: string;

    @property(Image.sizeProperty)
    size: Enums.Size = Enums.Size.Auto;

    @property(Image.styleProperty)
    style: Enums.ImageStyle = Enums.ImageStyle.Default;

    @property(Image.pixelWidthProperty)
    pixelWidth?: number;

    @property(Image.pixelHeightProperty)
    pixelHeight?: number;

    @property(Image.selectActionProperty)
    selectAction?: Action;

    //#endregion

    private applySize(element: HTMLElement) {
        if (this.pixelWidth || this.pixelHeight) {
            if (this.pixelWidth) {
                element.style.width = this.pixelWidth + "px";
            }

            if (this.pixelHeight) {
                element.style.height = this.pixelHeight + "px";
            }
        }
        else {
            switch (this.size) {
                case Enums.Size.Stretch:
                    element.style.width = "100%";
                    break;
                case Enums.Size.Auto:
                    element.style.maxWidth = "100%";
                    break;
                case Enums.Size.Small:
                    element.style.width = this.hostConfig.imageSizes.small + "px";
                    break;
                case Enums.Size.Large:
                    element.style.width = this.hostConfig.imageSizes.large + "px";
                    break;
                case Enums.Size.Medium:
                    element.style.width = this.hostConfig.imageSizes.medium + "px";
                    break;
            }
        }
    }

    protected get useDefaultSizing() {
        return false;
    }

    protected internalRender(): HTMLElement | undefined {
        let element: HTMLElement | undefined = undefined;

        if (!Utils.isNullOrEmpty(this.url)) {
            element = document.createElement("div");
            element.style.display = "flex";
            element.style.alignItems = "flex-start";

            element.onkeypress = (e) => {
                if (this.selectAction && (e.keyCode == 13 || e.keyCode == 32)) { // enter or space pressed
                    e.preventDefault();
                    e.cancelBubble = true;

                    this.selectAction.execute();
                }
            }

            element.onclick = (e) => {
                if (this.selectAction) {
                    e.preventDefault();
                    e.cancelBubble = true;

                    this.selectAction.execute();
                }
            }

            switch (this.horizontalAlignment) {
                case Enums.HorizontalAlignment.Center:
                    element.style.justifyContent = "center";
                    break;
                case Enums.HorizontalAlignment.Right:
                    element.style.justifyContent = "flex-end";
                    break;
                default:
                    element.style.justifyContent = "flex-start";
                    break;
            }

            // Cache hostConfig to avoid walking the parent hierarchy multiple times
            let hostConfig = this.hostConfig;

            let imageElement = document.createElement("img");
            imageElement.onload = (e: Event) => {
                raiseImageLoadedEvent(this);
            }
            imageElement.onerror = (e: Event) => {
                if (this.renderedElement) {
                    let card = this.getRootElement() as AdaptiveCard;

                    this.renderedElement.innerHTML = "";

                    if (card && card.designMode) {
                        let errorElement = document.createElement("div");
                        errorElement.style.display = "flex";
                        errorElement.style.alignItems = "center";
                        errorElement.style.justifyContent = "center";
                        errorElement.style.backgroundColor = "#EEEEEE";
                        errorElement.style.color = "black";
                        errorElement.innerText = ":-(";
                        errorElement.style.padding = "10px";

                        this.applySize(errorElement);

                        this.renderedElement.appendChild(errorElement);
                    }
                }

                raiseImageLoadedEvent(this);
            }
            imageElement.style.maxHeight = "100%";
            imageElement.style.minWidth = "0";
            imageElement.classList.add(hostConfig.makeCssClassName("ac-image"));

            if (this.selectAction !== undefined && hostConfig.supportsInteractivity) {
                imageElement.tabIndex = 0
                imageElement.setAttribute("role", "button");

                if (!Utils.isNullOrEmpty(this.selectAction.title)) {
                    imageElement.setAttribute("aria-label", <string>this.selectAction.title);
                }

                imageElement.classList.add(hostConfig.makeCssClassName("ac-selectable"));
            }

            this.applySize(imageElement);

            if (this.style === Enums.ImageStyle.Person) {
                imageElement.style.borderRadius = "50%";
                imageElement.style.backgroundPosition = "50% 50%";
                imageElement.style.backgroundRepeat = "no-repeat";
            }

            imageElement.style.backgroundColor = <string>Utils.stringToCssColor(this.backgroundColor);
            imageElement.src = <string>this.url;
            imageElement.alt = <string>this.altText;

            element.appendChild(imageElement);
        }

        return element;
    }

    getJsonTypeName(): string {
        return "Image";
    }

    getActionById(id: string) {
        let result = super.getActionById(id);

        if (!result && this.selectAction) {
            result = this.selectAction.getActionById(id);
        }

        return result;
    }

    getResourceInformation(): IResourceInformation[] {
        if (!Utils.isNullOrEmpty(this.url)) {
            return [{ url: <string>this.url, mimeType: "image" }]
        }
        else {
            return [];
        }
    }
}

export abstract class CardElementContainer extends CardElement {
    //#region Schema

    static readonly selectActionProperty = new ActionPropertyDefinition(Versions.v1_0, "selectAction", [ "Action.ShowCard" ]);

    protected populateSchema(schema: SerializableObjectSchema) {
        super.populateSchema(schema);

        if (!this.isSelectable) {
            schema.remove(CardElementContainer.selectActionProperty);
        }
    }

    @property(CardElementContainer.selectActionProperty)
    protected _selectAction?: Action;

    //#endregion

    protected isElementAllowed(element: CardElement, forbiddenElementTypes: string[]) {
        if (!this.hostConfig.supportsInteractivity && element.isInteractive) {
            return false;
        }

        if (forbiddenElementTypes) {
            for (let forbiddenElementType of forbiddenElementTypes) {
                if (element.getJsonTypeName() === forbiddenElementType) {
                    return false;
                }
            }
        }

        return true;
    }

    protected applyPadding() {
        super.applyPadding();

        if (!this.renderedElement) {
            return;
        }

        let physicalPadding = new SpacingDefinition();

        if (this.getEffectivePadding()) {
            physicalPadding = this.hostConfig.paddingDefinitionToSpacingDefinition(this.getEffectivePadding());
        }

        this.renderedElement.style.paddingTop = physicalPadding.top + "px";
        this.renderedElement.style.paddingRight = physicalPadding.right + "px";
        this.renderedElement.style.paddingBottom = physicalPadding.bottom + "px";
        this.renderedElement.style.paddingLeft = physicalPadding.left + "px";

        this.renderedElement.style.marginRight = "0";
        this.renderedElement.style.marginLeft = "0";
    }

    protected get isSelectable(): boolean {
        return false;
    }

    abstract getItemCount(): number;
    abstract getItemAt(index: number): CardElement;
    abstract getFirstVisibleRenderedItem(): CardElement | undefined;
    abstract getLastVisibleRenderedItem(): CardElement | undefined;
    abstract removeItem(item: CardElement): boolean;

    allowVerticalOverflow: boolean = false;

    internalValidateProperties(context: ValidationResults) {
        super.internalValidateProperties(context);

        for (let i = 0; i < this.getItemCount(); i++) {
            let item = this.getItemAt(i);

            if (!this.hostConfig.supportsInteractivity && item.isInteractive) {
                context.addFailure(
                    this,
                    {
                        error: Enums.ValidationError.InteractivityNotAllowed,
                        message: "Interactivity is not allowed."
                    });
            }

            if (!this.isElementAllowed(item, this.getForbiddenElementTypes())) {
                context.addFailure(
                    this,
                    {
                        error: Enums.ValidationError.InteractivityNotAllowed,
                        message: "Elements of type " + item.getJsonTypeName() + " are not allowed in this container."
                    });
            }

            item.internalValidateProperties(context);
        }

        if (this._selectAction) {
            this._selectAction.internalValidateProperties(context);
        }
    }

    render(): HTMLElement | undefined {
        let element = super.render();

        if (element) {
            let hostConfig = this.hostConfig;

            if (this.allowVerticalOverflow) {
                element.style.overflowX = "hidden";
                element.style.overflowY = "auto";
            }

            if (element && this.isSelectable && this._selectAction && hostConfig.supportsInteractivity) {
                element.classList.add(hostConfig.makeCssClassName("ac-selectable"));
                element.tabIndex = 0;
                element.setAttribute("role", "button");

                if (!Utils.isNullOrEmpty(this._selectAction.title)) {
                    element.setAttribute("aria-label", <string>this._selectAction.title);
                }

                element.onclick = (e) => {
                    if (this._selectAction !== undefined) {
                        e.preventDefault();
                        e.cancelBubble = true;

                        this._selectAction.execute();
                    }
                }

                element.onkeypress = (e) => {
                    if (this._selectAction !== undefined && (e.keyCode == 13 || e.keyCode == 32)) {
                        // Enter or space pressed
                        e.preventDefault();
                        e.cancelBubble = true;

                        this._selectAction.execute();
                    }
                }
            }
        }

        return element;
    }

    updateLayout(processChildren: boolean = true) {
        super.updateLayout(processChildren);

        if (processChildren) {
            for (let i = 0; i < this.getItemCount(); i++) {
                this.getItemAt(i).updateLayout();
            }
        }
    }

    getAllInputs(): Input[] {
        let result: Input[] = [];

        for (let i = 0; i < this.getItemCount(); i++) {
            result = result.concat(this.getItemAt(i).getAllInputs());
        }

        return result;
    }

    getResourceInformation(): IResourceInformation[] {
        let result: IResourceInformation[] = [];

        for (let i = 0; i < this.getItemCount(); i++) {
            result = result.concat(this.getItemAt(i).getResourceInformation());
        }

        return result;
    }

    getElementById(id: string): CardElement | undefined {
        let result = super.getElementById(id);

        if (!result) {
            for (let i = 0; i < this.getItemCount(); i++) {
                result = this.getItemAt(i).getElementById(id);

                if (result) {
                    break;
                }
            }
        }

        return result;
    }
}

export class ImageSet extends CardElementContainer {
    //#region Schema

    static readonly imagesProperty = new SerializableObjectCollectionProperty<Image>(
        Versions.v1_0,
        "images",
        (sender: SerializableObject, sourceItem: any) => { return new Image(); },
        (sender: SerializableObject) => { return []; },
        (sender: SerializableObject, item: Image) => { item.setParent(<CardElement>sender); });
    static readonly imageSizeProperty = new EnumProperty(
        Versions.v1_0,
        "imageSize",
        Enums.Size,
        Enums.Size.Medium);

    @property(ImageSet.imagesProperty)
    private _images: Image[] = [];

    @property(ImageSet.imageSizeProperty)
    imageSize: Enums.Size = Enums.Size.Medium;

    //#endregion

    protected internalRender(): HTMLElement | undefined {
        let element: HTMLElement | undefined = undefined;

        if (this._images.length > 0) {
            element = document.createElement("div");
            element.style.display = "flex";
            element.style.flexWrap = "wrap";

            for (let image of this._images) {
                image.size = this.imageSize;

                let renderedImage = image.render();

                if (renderedImage) {
                    renderedImage.style.display = "inline-flex";
                    renderedImage.style.margin = "0px";
                    renderedImage.style.marginRight = "10px";
                    renderedImage.style.maxHeight = this.hostConfig.imageSet.maxImageHeight + "px";

                    Utils.appendChild(element, renderedImage);
                }
            }
        }

        return element;
    }

    getItemCount(): number {
        return this._images.length;
    }

    getItemAt(index: number): CardElement {
        return this._images[index];
    }

    getFirstVisibleRenderedItem(): CardElement | undefined {
        return this._images && this._images.length > 0 ? this._images[0] : undefined;
    }

    getLastVisibleRenderedItem(): CardElement | undefined {
        return this._images && this._images.length > 0 ? this._images[this._images.length - 1] : undefined;
    }

    removeItem(item: CardElement): boolean {
        if (item instanceof Image) {
            let itemIndex = this._images.indexOf(item);

            if (itemIndex >= 0) {
                this._images.splice(itemIndex, 1);

                item.setParent(undefined);

                this.updateLayout();

                return true;
            }
        }

        return false;
    }

    getJsonTypeName(): string {
        return "ImageSet";
    }

    addImage(image: Image) {
        if (!image.parent) {
            this._images.push(image);

            image.setParent(this);
        }
        else {
            throw new Error("This image already belongs to another ImageSet");
        }
    }

    indexOf(cardElement: CardElement): number {
        return cardElement instanceof Image ? this._images.indexOf(cardElement) : -1;
    }
}

export class MediaSource extends SerializableObject {
    //#region Schema

    static readonly mimeTypeProperty = new StringProperty(Versions.v1_1, "mimeType");
    static readonly urlProperty = new StringProperty(Versions.v1_1, "url");

    @property(MediaSource.mimeTypeProperty)
    mimeType?: string;

    @property(MediaSource.urlProperty)
    url?: string;

    //#endregion

    protected getSchemaKey(): string {
        return "MediaSource";
    }

    constructor(url?: string, mimeType?: string) {
        super();

        this.url = url;
        this.mimeType = mimeType;
    }

    isValid(): boolean {
        return !Utils.isNullOrEmpty(this.mimeType) && !Utils.isNullOrEmpty(this.url);
    }

    render(): HTMLElement | undefined {
        let result: HTMLSourceElement | undefined = undefined;

        if (this.isValid()) {
            result = document.createElement("source");
            result.src = <string>this.url;
            result.type = <string>this.mimeType;
        }

        return result;
    }
}

export class Media extends CardElement {
    //#region Schema

    static readonly sourcesProperty = new SerializableObjectCollectionProperty<MediaSource>(
        Versions.v1_1,
        "sources",
        (sender: SerializableObject, sourceItem: any) => { return new MediaSource(); },
        (sender: SerializableObject) => { return []; });
    static readonly posterProperty = new StringProperty(Versions.v1_1, "poster");
    static readonly altTextProperty = new StringProperty(Versions.v1_1, "altText");

    @property(Media.sourcesProperty)
    sources: MediaSource[] = [];

    @property(Media.posterProperty)
    poster?: string;

    @property(Media.altTextProperty)
    altText?: string;

    //#endregion

    static readonly supportedMediaTypes = ["audio", "video"];

    private _selectedMediaType?: string;
    private _selectedSources: MediaSource[];

    private getPosterUrl(): string {
        return this.poster ? this.poster : this.hostConfig.media.defaultPoster;
    }

    private processSources() {
        this._selectedSources = [];
        this._selectedMediaType = undefined;

        for (let source of this.sources) {
            let mimeComponents = source.mimeType ? source.mimeType.split('/') : [];

            if (mimeComponents.length == 2) {
                if (!this._selectedMediaType) {
                    let index = Media.supportedMediaTypes.indexOf(mimeComponents[0]);

                    if (index >= 0) {
                        this._selectedMediaType = Media.supportedMediaTypes[index];
                    }
                }
                if (mimeComponents[0] == this._selectedMediaType) {
                    this._selectedSources.push(source);
                }
            }
        }
    }

    private renderPoster(): HTMLElement {
        const playButtonArrowWidth = 12;
        const playButtonArrowHeight = 15;

        let posterRootElement = document.createElement("div");
        posterRootElement.className = this.hostConfig.makeCssClassName("ac-media-poster");
        posterRootElement.setAttribute("role", "contentinfo");
        posterRootElement.setAttribute("aria-label", this.altText ? this.altText : "Media content");
        posterRootElement.style.position = "relative";
        posterRootElement.style.display = "flex";

        let posterUrl = this.getPosterUrl();

        if (posterUrl) {
            let posterImageElement = document.createElement("img");
            posterImageElement.style.width = "100%";
            posterImageElement.style.height = "100%";

            posterImageElement.onerror = (e: Event) => {
                if (posterImageElement.parentNode) {
                    posterImageElement.parentNode.removeChild(posterImageElement);
                }

                posterRootElement.classList.add("empty");
                posterRootElement.style.minHeight = "150px";
            }

            posterImageElement.src = posterUrl;

            posterRootElement.appendChild(posterImageElement);
        }
        else {
            posterRootElement.classList.add("empty");
            posterRootElement.style.minHeight = "150px";
        }

        if (this.hostConfig.supportsInteractivity && this._selectedSources.length > 0) {
            let playButtonOuterElement = document.createElement("div");
            playButtonOuterElement.setAttribute("role", "button");
            playButtonOuterElement.setAttribute("aria-label", "Play media");
            playButtonOuterElement.className = this.hostConfig.makeCssClassName("ac-media-playButton");
            playButtonOuterElement.style.display = "flex";
            playButtonOuterElement.style.alignItems = "center";
            playButtonOuterElement.style.justifyContent = "center";
            playButtonOuterElement.onclick = (e) => {
                if (this.hostConfig.media.allowInlinePlayback) {
                    e.preventDefault();
                    e.cancelBubble = true;

                    if (this.renderedElement) {
                        let mediaPlayerElement = this.renderMediaPlayer();

                        this.renderedElement.innerHTML = "";
                        this.renderedElement.appendChild(mediaPlayerElement);

                        mediaPlayerElement.play();
                    }
                }
                else {
                    if (Media.onPlay) {
                        e.preventDefault();
                        e.cancelBubble = true;

                        Media.onPlay(this);
                    }
                }
            }

            let playButtonInnerElement = document.createElement("div");
            playButtonInnerElement.className = this.hostConfig.makeCssClassName("ac-media-playButton-arrow");
            playButtonInnerElement.style.width = playButtonArrowWidth + "px";
            playButtonInnerElement.style.height = playButtonArrowHeight + "px";
            playButtonInnerElement.style.borderTopWidth = (playButtonArrowHeight / 2) + "px";
            playButtonInnerElement.style.borderBottomWidth = (playButtonArrowHeight / 2) + "px";
            playButtonInnerElement.style.borderLeftWidth = playButtonArrowWidth + "px";
            playButtonInnerElement.style.borderRightWidth = "0";
            playButtonInnerElement.style.borderStyle = "solid";
            playButtonInnerElement.style.borderTopColor = "transparent";
            playButtonInnerElement.style.borderRightColor = "transparent";
            playButtonInnerElement.style.borderBottomColor = "transparent";
            playButtonInnerElement.style.transform = "translate(" + (playButtonArrowWidth / 10) + "px,0px)";

            playButtonOuterElement.appendChild(playButtonInnerElement);

            let playButtonContainer = document.createElement("div");
            playButtonContainer.style.position = "absolute";
            playButtonContainer.style.left = "0";
            playButtonContainer.style.top = "0";
            playButtonContainer.style.width = "100%";
            playButtonContainer.style.height = "100%";
            playButtonContainer.style.display = "flex";
            playButtonContainer.style.justifyContent = "center";
            playButtonContainer.style.alignItems = "center";

            playButtonContainer.appendChild(playButtonOuterElement);
            posterRootElement.appendChild(playButtonContainer);
        }

        return posterRootElement;
    }

    private renderMediaPlayer(): HTMLMediaElement {
        let mediaElement: HTMLMediaElement;

        if (this._selectedMediaType == "video") {
            let videoPlayer = document.createElement("video");

            let posterUrl = this.getPosterUrl();

            if (posterUrl) {
                videoPlayer.poster = posterUrl;
            }

            mediaElement = videoPlayer;
        }
        else {
            mediaElement = document.createElement("audio");
        }

        mediaElement.controls = true;
        mediaElement.preload = "none";
        mediaElement.style.width = "100%";

        for (let source of this.sources) {
            let renderedSource = source.render();

            Utils.appendChild(mediaElement, renderedSource);
        }

        return mediaElement;
    }

    protected internalRender(): HTMLElement | undefined {
        let element = <HTMLElement>document.createElement("div");
        element.className = this.hostConfig.makeCssClassName("ac-media");

        this.processSources();

        element.appendChild(this.renderPoster());

        return element;
    }

    static onPlay: (sender: Media) => void;

    getJsonTypeName(): string {
        return "Media";
    }

    getResourceInformation(): IResourceInformation[] {
        let result: IResourceInformation[] = [];

        let posterUrl = this.getPosterUrl();

        if (!Utils.isNullOrEmpty(posterUrl)) {
            result.push({ url: posterUrl, mimeType: "image" });
        }

        for (let mediaSource of this.sources) {
            if (mediaSource.isValid()) {
                result.push(
                    {
                        url: <string>mediaSource.url,
                        mimeType: <string>mediaSource.mimeType
                    }
                );
            }
        }

        return result;
    }

    get selectedMediaType(): string | undefined {
        return this._selectedMediaType;
    }
}

export class InputValidationOptions extends SerializableObject {
    //#region Schema

    static readonly necessityProperty = new EnumProperty(Versions.vNext, "necessity", Enums.InputValidationNecessity, Enums.InputValidationNecessity.Optional);
    static readonly errorMessageProperty = new StringProperty(Versions.vNext, "errorMessagwe");

    protected getSchemaKey(): string {
        return "InputValidationOptions";
    }

    @property(InputValidationOptions.necessityProperty)
    necessity: Enums.InputValidationNecessity = Enums.InputValidationNecessity.Optional;

    @property(InputValidationOptions.errorMessageProperty)
    errorMessage?: string;

    //#endregion

    toJSON(): any {
        return this.hasAllDefaultValues() ? undefined : super.toJSON();
    }
}

export abstract class Input extends CardElement implements IInput {
    private _outerContainerElement: HTMLElement;
    private _inputControlContainerElement: HTMLElement;
    private _errorMessageElement?: HTMLElement;
    private _renderedInputControlElement: HTMLElement;

    protected get isNullable(): boolean {
        return true;
    }

    protected get renderedInputControlElement(): HTMLElement {
        return this._renderedInputControlElement;
    }

    protected get inputControlContainerElement(): HTMLElement {
        return this._inputControlContainerElement;
    }

    protected overrideInternalRender(): HTMLElement | undefined {
        let hostConfig = this.hostConfig;

        this._outerContainerElement = document.createElement("div");
        this._outerContainerElement.style.display = "flex";
        this._outerContainerElement.style.flexDirection = "column";

        this._inputControlContainerElement = document.createElement("div");
        this._inputControlContainerElement.className = hostConfig.makeCssClassName("ac-input-container");
        this._inputControlContainerElement.style.display = "flex";

        let renderedInputControlElement = this.internalRender();

        if (renderedInputControlElement) {
            this._renderedInputControlElement = renderedInputControlElement;
            this._renderedInputControlElement.style.minWidth = "0px";

            if (GlobalSettings.useBuiltInInputValidation && this.isNullable && this.validation.necessity == Enums.InputValidationNecessity.RequiredWithVisualCue) {
                this._renderedInputControlElement.classList.add(hostConfig.makeCssClassName("ac-input-required"));
            }

            this._inputControlContainerElement.appendChild(this._renderedInputControlElement);

            this._outerContainerElement.appendChild(this._inputControlContainerElement);

            return this._outerContainerElement;
        }

        return undefined;
    }

    protected valueChanged() {
        this.resetValidationFailureCue();

        if (this.onValueChanged) {
            this.onValueChanged(this);
        }

        raiseInputValueChangedEvent(this);
    }

    protected resetValidationFailureCue() {
        if (GlobalSettings.useBuiltInInputValidation && this.renderedElement) {
            this._renderedInputControlElement.classList.remove(this.hostConfig.makeCssClassName("ac-input-validation-failed"));

            if (this._errorMessageElement) {
                this._outerContainerElement.removeChild(this._errorMessageElement);

                this._errorMessageElement = undefined;
            }
        }
    }

    protected showValidationErrorMessage() {
        if (this.renderedElement && GlobalSettings.useBuiltInInputValidation && GlobalSettings.displayInputValidationErrors && !Utils.isNullOrEmpty(this.validation.errorMessage)) {
            this._errorMessageElement = document.createElement("span");
            this._errorMessageElement.className = this.hostConfig.makeCssClassName("ac-input-validation-error-message");
            this._errorMessageElement.textContent = <string>this.validation.errorMessage;

            this._outerContainerElement.appendChild(this._errorMessageElement);
        }
    }

    abstract get value(): any;

    onValueChanged: (sender: Input) => void;

    //#region Schema

    static readonly validationProperty = new SerializableObjectProperty(
        Versions.vNext,
        "validation",
        InputValidationOptions);

    protected populateSchema(schema: SerializableObjectSchema) {
        super.populateSchema(schema);

        if (!GlobalSettings.useBuiltInInputValidation) {
            schema.remove(Input.validationProperty);
        }
    }

    @property(Input.validationProperty)
    get validation(): InputValidationOptions {
        return this.getValue(Input.validationProperty);
    }

    //#endregion

    abstract isSet(): boolean;

    internalValidateProperties(context: ValidationResults) {
        super.internalValidateProperties(context);

        if (Utils.isNullOrEmpty(this.id)) {
            context.addFailure(
                this,
                {
                    error: Enums.ValidationError.PropertyCantBeNull,
                    message: "All inputs must have a unique Id"
                });
        }
    }

    validateValue(): boolean {
        if (GlobalSettings.useBuiltInInputValidation) {
            this.resetValidationFailureCue();

            let result = this.validation.necessity != Enums.InputValidationNecessity.Optional ? this.isSet() : true;

            if (!result && this.renderedElement) {
                this._renderedInputControlElement.classList.add(this.hostConfig.makeCssClassName("ac-input-validation-failed"));

                this.showValidationErrorMessage();
            }

            return result;
        }
        else {
            return true;
        }
    }

    getAllInputs(): Input[] {
        return [this];
    }

    get isInteractive(): boolean {
        return true;
    }
}

export class TextInput extends Input {
    //#region Schema

    static readonly valueProperty = new StringProperty(Versions.v1_0, "value");
    static readonly maxLengthProperty = new NumProperty(Versions.v1_0, "maxLength");
    static readonly isMultilineProperty = new BoolProperty(Versions.v1_0, "isMultiline", false);
    static readonly placeholderProperty = new StringProperty(Versions.v1_0, "placeholder");
    static readonly styleProperty = new EnumProperty(Versions.v1_0, "style", Enums.InputTextStyle, Enums.InputTextStyle.Text);
    static readonly inlineActionProperty = new ActionPropertyDefinition(Versions.v1_0, "inlineAction", [ "Action.ShowCard" ]);

    @property(TextInput.valueProperty)
    defaultValue?: string;

    @property(TextInput.maxLengthProperty)
    maxLength?: number;

    @property(TextInput.isMultilineProperty)
    isMultiline: boolean = false;

    @property(TextInput.placeholderProperty)
    placeholder?: string;

    @property(TextInput.styleProperty)
    style: Enums.InputTextStyle = Enums.InputTextStyle.Text;

    @property(TextInput.inlineActionProperty)
    inlineAction?: Action;

    //#endregion

    protected internalRender(): HTMLElement | undefined {
        if (this.isMultiline) {
            let textareaElement = document.createElement("textarea");
            textareaElement.className = this.hostConfig.makeCssClassName("ac-input", "ac-textInput", "ac-multiline");
            textareaElement.style.flex = "1 1 auto";
            textareaElement.tabIndex = 0;

            if (!Utils.isNullOrEmpty(this.placeholder)) {
                textareaElement.placeholder = <string>this.placeholder;
                textareaElement.setAttribute("aria-label", <string>this.placeholder)
            }

            if (!Utils.isNullOrEmpty(this.defaultValue)) {
                textareaElement.value = <string>this.defaultValue;
            }

            if (this.maxLength && this.maxLength > 0) {
                textareaElement.maxLength = this.maxLength;
            }

            textareaElement.oninput = () => { this.valueChanged(); }
            textareaElement.onkeypress = (e: KeyboardEvent) => {
                // Ctrl+Enter pressed
                if (e.keyCode == 10 && this.inlineAction) {
                    this.inlineAction.execute();
                }
            }

            return textareaElement;
        }
        else {
            let inputElement = document.createElement("input");
            inputElement.type = Enums.InputTextStyle[this.style].toLowerCase();
            inputElement.className = this.hostConfig.makeCssClassName("ac-input", "ac-textInput");
            inputElement.style.flex = "1 1 auto";
            inputElement.tabIndex = 0;

            if (!Utils.isNullOrEmpty(this.placeholder)) {
                inputElement.placeholder = <string>this.placeholder;
                inputElement.setAttribute("aria-label", <string>this.placeholder)
            }

            if (!Utils.isNullOrEmpty(this.defaultValue)) {
                inputElement.value = <string>this.defaultValue;
            }

            if (this.maxLength && this.maxLength > 0) {
                inputElement.maxLength = this.maxLength;
            }

            inputElement.oninput = () => { this.valueChanged(); }
            inputElement.onkeypress = (e: KeyboardEvent) => {
                // Enter pressed
                if (e.keyCode == 13 && this.inlineAction) {
                    this.inlineAction.execute();
                }
            }

            return inputElement;
        }
    }

    protected overrideInternalRender(): HTMLElement | undefined {
        let renderedInputControl = super.overrideInternalRender();

        if (this.inlineAction) {
            let button = document.createElement("button");
            button.className = this.hostConfig.makeCssClassName("ac-inlineActionButton");
            button.onclick = (e) => {
                e.preventDefault();
                e.cancelBubble = true;

                if (this.inlineAction) {
                    this.inlineAction.execute();
                }
            };

            if (!Utils.isNullOrEmpty(this.inlineAction.iconUrl)) {
                button.classList.add("iconOnly");

                let icon = document.createElement("img");
                icon.style.height = "100%";

                // The below trick is necessary as a workaround in Chrome where the icon is initially displayed
                // at its native size then resized to 100% of the button's height. This cfreates an unpleasant
                // flicker. On top of that, Chrome's flex implementation fails to prperly re-layout the button
                // after the image has loaded and been gicven its final size. The below trick also fixes that.
                icon.style.display = "none";
                icon.onload = () => {
                    icon.style.removeProperty("display");
                };
                icon.onerror = () => {
                    button.removeChild(icon);
                    button.classList.remove("iconOnly");
                    button.classList.add("textOnly");

                    if (this.inlineAction) {
                        button.textContent = !Utils.isNullOrEmpty(this.inlineAction.title) ? <string>this.inlineAction.title : "Title";
                    }
                    else {
                        button.textContent = "Title";
                    }
                }

                if (!Utils.isNullOrEmpty(this.inlineAction.iconUrl)) {
                    icon.src = <string>this.inlineAction.iconUrl;
                }

                button.appendChild(icon);

                if (!Utils.isNullOrEmpty(this.inlineAction.title)) {
                    button.title = <string>this.inlineAction.title;
                }
            }
            else {
                button.classList.add("textOnly");
                button.textContent = !Utils.isNullOrEmpty(this.inlineAction.title) ? <string>this.inlineAction.title : "Title";
            }

            button.style.marginLeft = "8px";

            this.inputControlContainerElement.appendChild(button);
        }

        return renderedInputControl;
    }

    getJsonTypeName(): string {
        return "Input.Text";
    }

    getActionById(id: string) {
        let result = super.getActionById(id);

        if (!result && this.inlineAction) {
            result = this.inlineAction.getActionById(id);
        }

        return result;
    }

    isSet(): boolean {
        return !Utils.isNullOrEmpty(this.value);
    }

    get value(): string | undefined {
        if (this.renderedInputControlElement) {
            if (this.isMultiline) {
                return (<HTMLTextAreaElement>this.renderedInputControlElement).value;
            }
            else {
                return (<HTMLInputElement>this.renderedInputControlElement).value;
            }
        }
        else {
            return undefined;
        }
    }
}

export class ToggleInput extends Input {
    //#region Schema

    static readonly valueProperty = new StringProperty(Versions.v1_0, "value");
    static readonly titleProperty = new StringProperty(Versions.v1_0, "title");
    static readonly valueOnProperty = new StringProperty(Versions.v1_0, "valueOn", true, undefined, "true", (sender: SerializableObject) => { return "true"; });
    static readonly valueOffProperty = new StringProperty(Versions.v1_0, "valueOff", true, undefined, "false", (sender: SerializableObject) => { return "false"; });
    static readonly wrapProperty = new BoolProperty(Versions.v1_2, "wrap", false);

    @property(ToggleInput.valueProperty)
    defaultValue?: string;

    @property(ToggleInput.titleProperty)
    title?: string;

    @property(ToggleInput.valueOnProperty)
    valueOn: string = "true";

    @property(ToggleInput.valueOffProperty)
    valueOff: string = "false";

    @property(ToggleInput.wrapProperty)
    wrap: boolean = false;

    //#endregion

    private _checkboxInputElement: HTMLInputElement;

    protected internalRender(): HTMLElement | undefined {
        let element = document.createElement("div");
        element.className = this.hostConfig.makeCssClassName("ac-input", "ac-toggleInput");
        element.style.width = "100%";
        element.style.display = "flex";
        element.style.alignItems = "center";

        this._checkboxInputElement = document.createElement("input");
        this._checkboxInputElement.id = Utils.generateUniqueId();
        this._checkboxInputElement.type = "checkbox";
        this._checkboxInputElement.style.display = "inline-block";
        this._checkboxInputElement.style.verticalAlign = "middle";
        this._checkboxInputElement.style.margin = "0";
        this._checkboxInputElement.style.flex = "0 0 auto";

        if (!Utils.isNullOrEmpty(this.title)) {
            this._checkboxInputElement.setAttribute("aria-label", <string>this.title);
        }

        this._checkboxInputElement.tabIndex = 0;

        if (this.defaultValue == this.valueOn) {
            this._checkboxInputElement.checked = true;
        }

        this._checkboxInputElement.onchange = () => { this.valueChanged(); }

        Utils.appendChild(element, this._checkboxInputElement);

        if (!Utils.isNullOrEmpty(this.title) || this.isDesignMode()) {
            let label = new Label();
            label.setParent(this);
            label.forElementId = this._checkboxInputElement.id;
            label.hostConfig = this.hostConfig;
            label.text = Utils.isNullOrEmpty(this.title) ? this.getJsonTypeName() : this.title;
            label.useMarkdown = GlobalSettings.useMarkdownInRadioButtonAndCheckbox;
            label.wrap = this.wrap;

            let labelElement = label.render();

            if (labelElement) {
                labelElement.style.display = "inline-block";
                labelElement.style.flex = "1 1 auto";
                labelElement.style.marginLeft = "6px";
                labelElement.style.verticalAlign = "middle";

                let spacerElement = document.createElement("div");
                spacerElement.style.width = "6px";

                Utils.appendChild(element, spacerElement);
                Utils.appendChild(element, labelElement);
            }
        }

        return element;
    }

    protected get isNullable(): boolean {
        return false;
    }

    getJsonTypeName(): string {
        return "Input.Toggle";
    }

    isSet(): boolean {
        return !Utils.isNullOrEmpty(this.value);
    }

    get value(): string | undefined {
        if (this._checkboxInputElement) {
            return this._checkboxInputElement.checked ? this.valueOn : this.valueOff;
        }
        else {
            return undefined;
        }
    }
}

export class Choice extends SerializableObject {
    //#region Schema

    static readonly titleProperty = new StringProperty(Versions.v1_0, "title");
    static readonly valueProperty = new StringProperty(Versions.v1_0, "value");

    @property(Choice.titleProperty)
    title?: string;

    @property(Choice.valueProperty)
    value?: string;

    //#endregion

    protected getSchemaKey(): string {
        return "Choice";
    }

    constructor(title?: string, value?: string) {
        super();

        this.title = title;
        this.value = value;
    }
}

export class ChoiceSetInput extends Input {
    //#region Schema

    static readonly valueProperty = new StringProperty(Versions.v1_0, "value");
    static readonly choicesProperty = new SerializableObjectCollectionProperty<Choice>(
        Versions.v1_0,
        "choices",
        (sourceItem: any) => { return new Choice(); },
        (sender: object) => { return []; });
    static readonly styleProperty = new ValueSetProperty(
        Versions.v1_0,
        "style",
        [
            { value: "compact" },
            { value: "expanded" }
        ]);
    static readonly isMultiSelectProperty = new BoolProperty(Versions.v1_0, "isMultiSelect", false);
    static readonly placeholderProperty = new StringProperty(Versions.v1_0, "placeholder");
    static readonly wrapProperty = new BoolProperty(Versions.v1_2, "wrap", false);

    @property(ChoiceSetInput.valueProperty)
    defaultValue?: string;

    @property(ChoiceSetInput.styleProperty)
    style?: "compact" | "expanded";

    get isCompact(): boolean {
        return this.style !== "expanded";
    }

    set isCompact(value: boolean) {
        this.style = value ? undefined : "expanded";
    }

    @property(ChoiceSetInput.isMultiSelectProperty)
    isMultiSelect: boolean = false;

    @property(ChoiceSetInput.placeholderProperty)
    placeholder?: string;

    @property(ChoiceSetInput.wrapProperty)
    wrap: boolean = false;

    @property(ChoiceSetInput.choicesProperty)
    choices: Choice[] = [];

    //#endregion

    private static uniqueCategoryCounter = 0;

    private static getUniqueCategoryName(): string {
        let uniqueCwtegoryName = "__ac-category" + ChoiceSetInput.uniqueCategoryCounter;

        ChoiceSetInput.uniqueCategoryCounter++;

        return uniqueCwtegoryName;
    }

    private _selectElement: HTMLSelectElement;
    private _toggleInputs: HTMLInputElement[];

    protected internalRender(): HTMLElement | undefined {
        if (!this.isMultiSelect) {
            if (this.isCompact) {
                // Render as a combo box
                this._selectElement = document.createElement("select");
                this._selectElement.className = this.hostConfig.makeCssClassName("ac-input", "ac-multichoiceInput", "ac-choiceSetInput-compact");
                this._selectElement.style.width = "100%";

                let option = document.createElement("option");
                option.selected = true;
                option.disabled = true;
                option.hidden = true;
                option.value = "";

                if (this.placeholder) {
                    option.text = this.placeholder;
                }

                Utils.appendChild(this._selectElement, option);

                for (let choice of this.choices) {
                    let option = document.createElement("option");
                    option.value = <string>choice.value;
                    option.text = <string>choice.title;
                    option.setAttribute("aria-label", <string>choice.title);

                    if (choice.value == this.defaultValue) {
                        option.selected = true;
                    }

                    Utils.appendChild(this._selectElement, option);
                }

                this._selectElement.onchange = () => { this.valueChanged(); }

                return this._selectElement;
            }
            else {
                // Render as a series of radio buttons
                let uniqueCategoryName = ChoiceSetInput.getUniqueCategoryName();

                let element = document.createElement("div");
                element.className = this.hostConfig.makeCssClassName("ac-input", "ac-choiceSetInput-expanded");
                element.style.width = "100%";

                this._toggleInputs = [];

                let i = 0;

                for (let choice of this.choices) {
                    let radioInput = document.createElement("input");
                    radioInput.id = Utils.generateUniqueId();
                    radioInput.type = "radio";
                    radioInput.style.margin = "0";
                    radioInput.style.display = "inline-block";
                    radioInput.style.verticalAlign = "middle";
                    radioInput.name = Utils.isNullOrEmpty(this.id) ? uniqueCategoryName : this.id;
                    radioInput.value = <string>choice.value;
                    radioInput.style.flex = "0 0 auto";
                    radioInput.setAttribute("aria-label", <string>choice.title);

                    if (choice.value == this.defaultValue) {
                        radioInput.checked = true;
                    }

                    radioInput.onchange = () => { this.valueChanged(); }

                    this._toggleInputs.push(radioInput);

                    let compoundInput = document.createElement("div");
                    compoundInput.style.display = "flex";
                    compoundInput.style.alignItems = "center";

                    Utils.appendChild(compoundInput, radioInput);

                    let label = new Label();
                    label.setParent(this);
                    label.forElementId = radioInput.id;
                    label.hostConfig = this.hostConfig;
                    label.text = Utils.isNullOrEmpty(choice.title) ? "Choice " + (i++) : choice.title;
                    label.useMarkdown = GlobalSettings.useMarkdownInRadioButtonAndCheckbox;
                    label.wrap = this.wrap;

                    let labelElement = label.render();
                    
                    if (labelElement) {
                        labelElement.style.display = "inline-block";
                        labelElement.style.flex = "1 1 auto";
                        labelElement.style.marginLeft = "6px";
                        labelElement.style.verticalAlign = "middle";

                        let spacerElement = document.createElement("div");
                        spacerElement.style.width = "6px";

                        Utils.appendChild(compoundInput, spacerElement);
                        Utils.appendChild(compoundInput, labelElement);
                    }

                    Utils.appendChild(element, compoundInput);
                }

                return element;
            }
        }
        else {
            // Render as a list of toggle inputs
            let defaultValues = this.defaultValue ? this.defaultValue.split(this.hostConfig.choiceSetInputValueSeparator) : undefined;

            let element = document.createElement("div");
            element.className = this.hostConfig.makeCssClassName("ac-input", "ac-choiceSetInput-multiSelect");
            element.style.width = "100%";

            this._toggleInputs = [];

            let i = 0;

            for (let choice of this.choices) {
                let checkboxInput = document.createElement("input");
                checkboxInput.id = Utils.generateUniqueId();
                checkboxInput.type = "checkbox";
                checkboxInput.style.margin = "0";
                checkboxInput.style.display = "inline-block";
                checkboxInput.style.verticalAlign = "middle";
                checkboxInput.value = <string>choice.value;
                checkboxInput.style.flex = "0 0 auto";
                checkboxInput.setAttribute("aria-label", <string>choice.title);

                if (defaultValues) {
                    if (defaultValues.indexOf(<string>choice.value) >= 0) {
                        checkboxInput.checked = true;
                    }
                }

                checkboxInput.onchange = () => { this.valueChanged(); }

                this._toggleInputs.push(checkboxInput);

                let compoundInput = document.createElement("div");
                compoundInput.style.display = "flex";
                compoundInput.style.alignItems = "center";

                Utils.appendChild(compoundInput, checkboxInput);

                let label = new Label();
                label.setParent(this);
                label.forElementId = checkboxInput.id;
                label.hostConfig = this.hostConfig;
                label.text = Utils.isNullOrEmpty(choice.title) ? "Choice " + (i++) : choice.title;
                label.useMarkdown = GlobalSettings.useMarkdownInRadioButtonAndCheckbox;
                label.wrap = this.wrap;

                let labelElement = label.render();

                if (labelElement) {
                    labelElement.style.display = "inline-block";
                    labelElement.style.flex = "1 1 auto";
                    labelElement.style.marginLeft = "6px";
                    labelElement.style.verticalAlign = "middle";

                    let spacerElement = document.createElement("div");
                    spacerElement.style.width = "6px";

                    Utils.appendChild(compoundInput, spacerElement);
                    Utils.appendChild(compoundInput, labelElement);
                }

                Utils.appendChild(element, compoundInput);
            }

            return element;
        }
    }

    getJsonTypeName(): string {
        return "Input.ChoiceSet";
    }

    internalValidateProperties(context: ValidationResults) {
        super.internalValidateProperties(context);

        if (this.choices.length == 0) {
            context.addFailure(
                this,
                {
                    error: Enums.ValidationError.CollectionCantBeEmpty,
                    message: "An Input.ChoiceSet must have at least one choice defined."
                });
        }

        for (let choice of this.choices) {
            if (!choice.title || !choice.value) {
                context.addFailure(
                    this,
                    {
                        error: Enums.ValidationError.PropertyCantBeNull,
                        message: "All choices in an Input.ChoiceSet must have their title and value properties set."
                    });
            }
        }
    }

    isSet(): boolean {
        return !Utils.isNullOrEmpty(this.value);
    }

    get value(): string | undefined {
        if (!this.isMultiSelect) {
            if (this.isCompact) {
                if (this._selectElement) {
                    return this._selectElement.selectedIndex > 0 ? this._selectElement.value : undefined;
                }

                return undefined;
            }
            else {
                if (!this._toggleInputs || this._toggleInputs.length == 0) {
                    return undefined;
                }

                for (let toggleInput of this._toggleInputs) {
                    if (toggleInput.checked) {
                        return toggleInput.value;
                    }
                }

                return undefined;
            }
        }
        else {
            if (!this._toggleInputs || this._toggleInputs.length == 0) {
                return undefined;
            }

            let result: string = "";

            for (let toggleInput of this._toggleInputs) {
                if (toggleInput.checked) {
                    if (result != "") {
                        result += this.hostConfig.choiceSetInputValueSeparator;
                    }

                    result += toggleInput.value;
                }
            }

            return Utils.isNullOrEmpty(result) ? undefined : result;
        }
    }
}

export class NumberInput extends Input {
    //#region Schema

    static readonly valueProperty = new NumProperty(Versions.v1_0, "value");
    static readonly placeholderProperty = new StringProperty(Versions.v1_0, "placeholder");
    static readonly minProperty = new NumProperty(Versions.v1_0, "min");
    static readonly maxProperty = new NumProperty(Versions.v1_0, "max");

    @property(NumberInput.valueProperty)
    defaultValue?: number;

    @property(NumberInput.minProperty)
    min?: number;

    @property(NumberInput.maxProperty)
    max?: number;

    @property(NumberInput.placeholderProperty)
    placeholder?: string;

    //#endregion

    private _numberInputElement: HTMLInputElement;

    protected internalRender(): HTMLElement | undefined {
        this._numberInputElement = document.createElement("input");
        this._numberInputElement.setAttribute("type", "number");

        if (this.min) {
            this._numberInputElement.setAttribute("min", this.min.toString());
        }

        if (this.max) {
            this._numberInputElement.setAttribute("max", this.max.toString());
        }

        this._numberInputElement.className = this.hostConfig.makeCssClassName("ac-input", "ac-numberInput");
        this._numberInputElement.style.width = "100%";
        this._numberInputElement.tabIndex = 0;

        if (this.defaultValue !== undefined) {
            this._numberInputElement.valueAsNumber = this.defaultValue;
        }

        if (!Utils.isNullOrEmpty(this.placeholder)) {
            this._numberInputElement.placeholder = <string>this.placeholder;
            this._numberInputElement.setAttribute("aria-label", <string>this.placeholder);
        }

        this._numberInputElement.oninput = () => { this.valueChanged(); }

        return this._numberInputElement;
    }

    getJsonTypeName(): string {
        return "Input.Number";
    }

    isSet(): boolean {
        return this.value !== undefined && !isNaN(this.value);
    }

    get value(): number | undefined {
        return this._numberInputElement ? this._numberInputElement.valueAsNumber : undefined;
    }
}

export class DateInput extends Input {
    //#region Schema

    static readonly valueProperty = new StringProperty(Versions.v1_0, "value");
    static readonly placeholderProperty = new StringProperty(Versions.v1_0, "placeholder");
    static readonly minProperty = new StringProperty(Versions.v1_0, "min");
    static readonly maxProperty = new StringProperty(Versions.v1_0, "max");

    @property(DateInput.valueProperty)
    defaultValue?: string;

    @property(DateInput.minProperty)
    min?: string;

    @property(DateInput.maxProperty)
    max?: string;

    @property(DateInput.placeholderProperty)
    placeholder?: string;

    //#endregion

    private _dateInputElement: HTMLInputElement;

    protected internalRender(): HTMLElement | undefined {
        this._dateInputElement = document.createElement("input");
        this._dateInputElement.setAttribute("type", "date");
        this._dateInputElement.setAttribute("min", <string>this.min);
        this._dateInputElement.setAttribute("max", <string>this.max);

        if (!Utils.isNullOrEmpty(this.placeholder)) {
            this._dateInputElement.placeholder = <string>this.placeholder;
            this._dateInputElement.setAttribute("aria-label", <string>this.placeholder);
        }

        this._dateInputElement.className = this.hostConfig.makeCssClassName("ac-input", "ac-dateInput");
        this._dateInputElement.style.width = "100%";

        this._dateInputElement.oninput = () => { this.valueChanged(); }

        if (!Utils.isNullOrEmpty(this.defaultValue)) {
            this._dateInputElement.value = <string>this.defaultValue;
        }

        return this._dateInputElement;
    }

    getJsonTypeName(): string {
        return "Input.Date";
    }

    isSet(): boolean {
        return !Utils.isNullOrEmpty(this.value);
    }

    get value(): string | undefined {
        return this._dateInputElement ? this._dateInputElement.value : undefined;
    }
}

export class TimePropertyDefinition extends CustomProperty<string | undefined> {
    constructor(readonly targetVersion: TargetVersion, readonly name: string) {
        super(
            targetVersion,
            name,
            (sender: SerializableObject, property: PropertyDefinition, source: PropertyBag, errors?: IValidationError[]) => {
                let value = source[property.name];
    
                if (typeof value === "string" && !Utils.isNullOrEmpty(value) && /^[0-9]{2}:[0-9]{2}$/.test(value)) {
                    return value;
                }
    
                return undefined;
            },
            (sender: SerializableObject, property: PropertyDefinition, target: PropertyBag, value: string | undefined) => {
                Utils.setProperty(target, property.name, value);
            });
    }
}

export class TimeInput extends Input {
    //#region Schema

    static readonly valueProperty = new TimePropertyDefinition(Versions.v1_0, "value");
    static readonly placeholderProperty = new StringProperty(Versions.v1_0, "placeholder");
    static readonly minProperty = new TimePropertyDefinition(Versions.v1_0, "min");
    static readonly maxProperty = new TimePropertyDefinition(Versions.v1_0, "max");

    @property(TimeInput.valueProperty)
    defaultValue?: string;

    @property(TimeInput.minProperty)
    min?: string;

    @property(TimeInput.maxProperty)
    max?: string;

    @property(TimeInput.placeholderProperty)
    placeholder?: string;

    //#endregion

    private _timeInputElement: HTMLInputElement;

    protected internalRender(): HTMLElement | undefined {
        this._timeInputElement = document.createElement("input");
        this._timeInputElement.setAttribute("type", "time");
        this._timeInputElement.setAttribute("min", <string>this.min);
        this._timeInputElement.setAttribute("max", <string>this.max);
        this._timeInputElement.className = this.hostConfig.makeCssClassName("ac-input", "ac-timeInput");
        this._timeInputElement.style.width = "100%";
        this._timeInputElement.oninput = () => { this.valueChanged(); }

        if (!Utils.isNullOrEmpty(this.placeholder)) {
            this._timeInputElement.placeholder = <string>this.placeholder;
            this._timeInputElement.setAttribute("aria-label", <string>this.placeholder);
        }

        if (!Utils.isNullOrEmpty(this.defaultValue)) {
            this._timeInputElement.value = <string>this.defaultValue;
        }

        return this._timeInputElement;
    }

    getJsonTypeName(): string {
        return "Input.Time";
    }

    isSet(): boolean {
        return !Utils.isNullOrEmpty(this.value);
    }

    get value(): string | undefined {
        return this._timeInputElement ? this._timeInputElement.value : undefined;
    }
}

const enum ActionButtonState {
    Normal,
    Expanded,
    Subdued
}

class ActionButton {
    private _parentContainerStyle: string;
    private _state: ActionButtonState = ActionButtonState.Normal;

    private updateCssStyle() {
        if (this.action.parent && this.action.renderedElement) {
            let hostConfig = this.action.parent.hostConfig;

            this.action.renderedElement.className = hostConfig.makeCssClassName("ac-pushButton");

            if (!Utils.isNullOrEmpty(this._parentContainerStyle)) {
                this.action.renderedElement.classList.add("style-" + this._parentContainerStyle);
            }

            this.action.updateActionButtonCssStyle(this.action.renderedElement);

            this.action.renderedElement.classList.remove(hostConfig.makeCssClassName("expanded"));
            this.action.renderedElement.classList.remove(hostConfig.makeCssClassName("subdued"));

            switch (this._state) {
                case ActionButtonState.Expanded:
                    this.action.renderedElement.classList.add(hostConfig.makeCssClassName("expanded"));
                    break;
                case ActionButtonState.Subdued:
                    this.action.renderedElement.classList.add(hostConfig.makeCssClassName("subdued"));
                    break;
            }

            if (!Utils.isNullOrEmpty(this.action.style)) {
                if (this.action.style === Enums.ActionStyle.Positive) {
                    this.action.renderedElement.classList.add(...hostConfig.makeCssClassNames("primary", "style-positive"));
                }
                else {
                    this.action.renderedElement.classList.add(...hostConfig.makeCssClassNames("style-" + this.action.style.toLowerCase()));
                }
            }
        }
    }

    readonly action: Action;

    constructor(action: Action, parentContainerStyle: string) {
        this.action = action;
        this._parentContainerStyle = parentContainerStyle;
    }

    onClick?: (actionButton: ActionButton) => void;

    render() {
        this.action.render();

        if (this.action.renderedElement) {
            this.action.renderedElement.onclick = (e) => {
                e.preventDefault();
                e.cancelBubble = true;

                this.click();
            };

            this.updateCssStyle();
        }
    }

    click() {
        if (this.onClick !== undefined) {
            this.onClick(this);
        }
    }

    get state(): ActionButtonState {
        return this._state;
    }

    set state(value: ActionButtonState) {
        this._state = value;

        this.updateCssStyle();
    }
}

export abstract class Action extends CardObject {
    //#region Schema

    /* TODO: parsing validation for title
            raiseParseError(
                {
                    error: Enums.ValidationError.PropertyCantBeNull,
                    message: "Actions should always have a title."
                },
                errors
            );
    */
    static readonly titleProperty = new StringProperty(Versions.v1_0, "title");
    static readonly iconUrlProperty = new StringProperty(Versions.v1_1, "iconUrl");
    static readonly styleProperty = new ValueSetProperty(
        Versions.v1_2,
        "style",
        [
            { value: Enums.ActionStyle.Default },
            { value: Enums.ActionStyle.Positive },
            { value: Enums.ActionStyle.Destructive }
        ],
        Enums.ActionStyle.Default);
    static readonly requiresProperty = new SerializableObjectProperty(
        Versions.v1_2,
        "requires",
        HostCapabilities);
    // TODO: Revise this when finalizing input validation
    static readonly ignoreInputValidationProperty = new BoolProperty(Versions.vNext, "ignoreInputValidation", false);

    @property(Action.titleProperty)
    title?: string;

    @property(Action.iconUrlProperty)
    iconUrl?: string;

    @property(Action.styleProperty)
    style: string = Enums.ActionStyle.Default;

    //#endregion

    private _actionCollection?: ActionCollection; // hold the reference to its action collection
    private _renderedElement?: HTMLElement;

    protected addCssClasses(element: HTMLElement) {
        // Do nothing in base implementation
    }

    protected internalGetReferencedInputs(allInputs: Input[]): Dictionary<Input> {
        return {};
    }

    protected internalPrepareForExecution(inputs: Dictionary<Input> | undefined) {
        // Do nothing in base implementation
    }

    protected internalValidateInputs(referencedInputs: Dictionary<Input> | undefined): Input[] {
        let result: Input[] = [];

        if (GlobalSettings.useBuiltInInputValidation && !this.ignoreInputValidation && referencedInputs) {
            for (let key of Object.keys(referencedInputs)) {
                let input = referencedInputs[key];

                if (!input.validateValue()) {
                    result.push(input);
                }
            }
        }

        return result;
    }

    onExecute: (sender: Action) => void;

    getHref(): string | undefined {
        return "";
    }

    updateActionButtonCssStyle(actionButtonElement: HTMLElement): void {
        // Do nothing in base implementation
    }

    parse(json: any, errors?: IValidationError[]) {
		super.parse(json, errors);

        raiseParseActionEvent(this, json, errors);
    }

    render(baseCssClass: string = "ac-pushButton") {
        // Cache hostConfig for perf
        let hostConfig = this.hostConfig;

        let buttonElement = document.createElement("button");

        this.addCssClasses(buttonElement);

        if (!Utils.isNullOrEmpty(this.title)) {
            buttonElement.setAttribute("aria-label", <string>this.title);
        }

        buttonElement.type = "button";
        buttonElement.style.display = "flex";
        buttonElement.style.alignItems = "center";
        buttonElement.style.justifyContent = "center";

        let hasTitle = !Utils.isNullOrEmpty(this.title);

        let titleElement = document.createElement("div");
        titleElement.style.overflow = "hidden";
        titleElement.style.textOverflow = "ellipsis";

        if (!(hostConfig.actions.iconPlacement == Enums.ActionIconPlacement.AboveTitle || hostConfig.actions.allowTitleToWrap)) {
            titleElement.style.whiteSpace = "nowrap";
        }

        if (hasTitle) {
            titleElement.innerText = <string>this.title;
        }

        if (Utils.isNullOrEmpty(this.iconUrl)) {
            buttonElement.classList.add("noIcon");

            buttonElement.appendChild(titleElement);
        }
        else {
            let iconElement = document.createElement("img");
            iconElement.src = <string>this.iconUrl;
            iconElement.style.width = hostConfig.actions.iconSize + "px";
            iconElement.style.height = hostConfig.actions.iconSize + "px";
            iconElement.style.flex = "0 0 auto";

            if (hostConfig.actions.iconPlacement == Enums.ActionIconPlacement.AboveTitle) {
                buttonElement.classList.add("iconAbove");
                buttonElement.style.flexDirection = "column";

                if (hasTitle) {
                    iconElement.style.marginBottom = "6px";
                }
            }
            else {
                buttonElement.classList.add("iconLeft");

                iconElement.style.maxHeight = "100%";

                if (hasTitle) {
                    iconElement.style.marginRight = "6px";
                }
            }

            buttonElement.appendChild(iconElement);
            buttonElement.appendChild(titleElement);
        }

        this._renderedElement = buttonElement;
    }

    execute() {
        if (this.onExecute) {
            this.onExecute(this);
        }

        raiseExecuteActionEvent(this);
    }

    prepareForExecution(): boolean {
        let referencedInputs = this.getReferencedInputs();

        if (this.internalValidateInputs(referencedInputs).length > 0) {
            return false;
        }

        this.internalPrepareForExecution(referencedInputs);

        return true;
    };

    remove(): boolean {
        if (this._actionCollection) {
            return this._actionCollection.removeAction(this);
        }

        return false;
    }

    getAllInputs(): Input[] {
        return [];
    }

    getResourceInformation(): IResourceInformation[] {
        if (!Utils.isNullOrEmpty(this.iconUrl)) {
            return [{ url: <string>this.iconUrl, mimeType: "image" }]
        }
        else {
            return [];
        }
    }

    getActionById(id: string): Action | undefined {
        if (this.id == id) {
            return this;
        }
        else {
            return undefined;
        }
    }

    getReferencedInputs(): Dictionary<Input> | undefined {
        return this.parent ? this.internalGetReferencedInputs(this.parent.getRootElement().getAllInputs()) : undefined;
    }

    validateInputs() {
        return this.internalValidateInputs(this.getReferencedInputs());
    }

    get isPrimary(): boolean {
        return this.style == Enums.ActionStyle.Positive;
    }

    set isPrimary(value: boolean) {
        if (value) {
            this.style = Enums.ActionStyle.Positive;
        }
        else {
            if (this.style == Enums.ActionStyle.Positive) {
                this.style = Enums.ActionStyle.Default;
            }
        }
    }

    get ignoreInputValidation(): boolean {
        return true;
    }

    get renderedElement(): HTMLElement | undefined {
        return this._renderedElement;
    }

    get hostConfig(): HostConfig.HostConfig {
        return this.parent ? this.parent.hostConfig : defaultHostConfig;
    }
}

export class SubmitAction extends Action {
    //#region Schema

    static readonly dataProperty = new PropertyDefinition(Versions.v1_0, "data");

    @property(SubmitAction.dataProperty)
    private _originalData?: PropertyBag;

    @property(Action.ignoreInputValidationProperty)
    private _ignoreInputValidation: boolean = false;

    //#endregion

    // Note the "weird" way this field is declared is to work around a breaking
    // change introduced in TS 3.1 wrt d.ts generation. DO NOT CHANGE
    static readonly JsonTypeName: "Action.Submit" = "Action.Submit";

    private _isPrepared: boolean = false;
    private _processedData?: PropertyBag;

    protected internalGetReferencedInputs(allInputs: Input[]): Dictionary<Input> {
        let result: Dictionary<Input> = {};

        for (let input of allInputs) {
            result[input.id] = input;
        }

        return result;
    }

    protected internalPrepareForExecution(inputs: Dictionary<Input>) {
        if (this._originalData) {
            this._processedData = JSON.parse(JSON.stringify(this._originalData));
        }
        else {
            this._processedData = {};
        }

        if (this._processedData) {
            for (let key of Object.keys(inputs)) {
                let input = inputs[key];

                if (input.isSet()) {
                    this._processedData[input.id] = input.value;
                }
            }
        }

        this._isPrepared = true;
    }

    getJsonTypeName(): string {
        return SubmitAction.JsonTypeName;
    }

    get ignoreInputValidation(): boolean {
        return this._ignoreInputValidation;
    }

    set ignoreInputValidation(value: boolean) {
        this._ignoreInputValidation = value;
    }

    get data(): object | undefined {
        return this._isPrepared ? this._processedData : this._originalData;
    }

    set data(value: object | undefined) {
        this._originalData = value;
        this._isPrepared = false;
    }
}

export class OpenUrlAction extends Action {
    //#region Schema

    static readonly urlProperty = new StringProperty(Versions.v1_0, "url");

    @property(OpenUrlAction.urlProperty)
    url?: string;

    //#endregion

    // Note the "weird" way this field is declared is to work around a breaking
    // change introduced in TS 3.1 wrt d.ts generation. DO NOT CHANGE
    static readonly JsonTypeName: "Action.OpenUrl" = "Action.OpenUrl";

    getJsonTypeName(): string {
        return OpenUrlAction.JsonTypeName;
    }

    internalValidateProperties(context: ValidationResults) {
        super.internalValidateProperties(context);

        if (Utils.isNullOrEmpty(this.url)) {
            context.addFailure(
                this,
                {
                    error: Enums.ValidationError.PropertyCantBeNull,
                    message: "An Action.OpenUrl must have its url property set."
                });
        }
    }

    getHref(): string | undefined {
        return this.url;
    }
}

export class ToggleVisibilityAction extends Action {
    //#region Schema

    static readonly targetElementsProperty = new CustomProperty<PropertyBag>(
        Versions.v1_2,
        "targetElements",
        (sender: SerializableObject, property: PropertyDefinition, source: PropertyBag, errors?: IValidationError[]) => {
            let result: PropertyBag = {}

            if (Array.isArray(source[property.name])) {
                for (let item of source[property.name]) {
                    if (typeof item === "string") {
                        result[item] = undefined;
                    }
                    else if (typeof item === "object") {
                        let elementId = item["elementId"];
    
                        if (typeof elementId === "string") {
                            result[elementId] = Utils.getBoolValue(item["isVisible"]);
                        }
                    }
                }
            }

            return result;
        },
        (sender: SerializableObject, property: PropertyDefinition, target: PropertyBag, value: PropertyBag) => {
            let targetElements: any[] = [];

            for (let id of Object.keys(value)) {
                if (typeof value[id] === "boolean") {
                    targetElements.push(
                        {
                            elementId: id,
                            isVisible: value[id]
                        }
                    );
                }
                else {
                    targetElements.push(id);
                }
            }
    
            Utils.setArrayProperty(target, property.name, targetElements);
        },
        {},
        (sender: SerializableObject) => { return {}; });

    @property(ToggleVisibilityAction.targetElementsProperty)
    targetElements: { [key: string]: any } = {};

    //#endregion

    // Note the "weird" way this field is declared is to work around a breaking
    // change introduced in TS 3.1 wrt d.ts generation. DO NOT CHANGE
    static readonly JsonTypeName: "Action.ToggleVisibility" = "Action.ToggleVisibility";

    getJsonTypeName(): string {
        return ToggleVisibilityAction.JsonTypeName;
    }

    execute() {
        if (this.parent) {
            for (let elementId of Object.keys(this.targetElements)) {
                let targetElement = this.parent.getRootElement().getElementById(elementId);

                if (targetElement) {
                    if (typeof this.targetElements[elementId] === "boolean") {
                        targetElement.isVisible = this.targetElements[elementId];
                    }
                    else {
                        targetElement.isVisible = !targetElement.isVisible;
                    }
                }
            }
        }
    }

    addTargetElement(elementId: string, isVisible: boolean | undefined = undefined) {
        this.targetElements[elementId] = isVisible;
    }

    removeTargetElement(elementId: string) {
        delete this.targetElements[elementId];
    }
}

class StringWithSubstitutionPropertyDefinition extends PropertyDefinition  {
    parse(sender: SerializableObject, source: PropertyBag, errors?: IValidationError[]): StringWithSubstitutions {
        let result = new StringWithSubstitutions();
        result.set(Utils.getStringValue(source[this.name]));

        return result;
    }

    toJSON(sender: SerializableObject, target: PropertyBag, value: StringWithSubstitutions): void {
        Utils.setProperty(target, this.name, value.getOriginal());
    }

    constructor(
        readonly targetVersion: TargetVersion,
        readonly name: string) {
        super(targetVersion, name, undefined, () => { return new StringWithSubstitutions(); });
    }
}

export class HttpHeader extends SerializableObject {
    //#region Schema

    static readonly nameProperty = new StringProperty(Versions.v1_0, "name");
    static readonly valueProperty = new StringWithSubstitutionPropertyDefinition(Versions.v1_0, "value");

    protected getSchemaKey(): string {
        return "HttpHeader";
    }

    @property(HttpHeader.nameProperty)
    name: string;

    @property(HttpHeader.valueProperty)
    private _value: StringWithSubstitutions;

    //#endregion

    constructor(name: string = "", value: string = "") {
        super();

        this.name = name;
        this.value = value;
    }

    getReferencedInputs(inputs: Input[], referencedInputs: Dictionary<Input>) {
        this._value.getReferencedInputs(inputs, referencedInputs);
    }

    prepareForExecution(inputs: Dictionary<Input>) {
        this._value.substituteInputValues(inputs, ContentTypes.applicationXWwwFormUrlencoded);
    }

    get value(): string | undefined {
        return this._value.get();
    }

    set value(newValue: string | undefined) {
        this._value.set(newValue);
    }
}

export class HttpAction extends Action {
    //#region Schema

    static readonly urlProperty = new StringWithSubstitutionPropertyDefinition(Versions.v1_0, "url");
    static readonly bodyProperty = new StringWithSubstitutionPropertyDefinition(Versions.v1_0, "body");
    static readonly methodProperty = new StringProperty(Versions.v1_0, "method");
    static readonly headersProperty = new SerializableObjectCollectionProperty(
        Versions.v1_0,
        "headers",
        (sender: SerializableObject, sourceItem: any) => { return new HttpHeader(); });

    protected populateSchema(schema: SerializableObjectSchema) {
        super.populateSchema(schema);

        schema.add(Action.ignoreInputValidationProperty);
    }

    @property(HttpAction.urlProperty)
    private _url: StringWithSubstitutions;

    @property(HttpAction.bodyProperty)
    private _body: StringWithSubstitutions;

    @property(HttpAction.bodyProperty)
    method?: string;

    @property(HttpAction.headersProperty)
    headers: HttpHeader[] = [];

    @property(Action.ignoreInputValidationProperty)
    private _ignoreInputValidation: boolean = false;

    //#endregion

    // Note the "weird" way this field is declared is to work around a breaking
    // change introduced in TS 3.1 wrt d.ts generation. DO NOT CHANGE
    static readonly JsonTypeName: "Action.Http" = "Action.Http";

    protected internalGetReferencedInputs(allInputs: Input[]): Dictionary<Input> {
        let result: Dictionary<Input> = {};

        this._url.getReferencedInputs(allInputs, result);

        for (let header of this.headers) {
            header.getReferencedInputs(allInputs, result);
        }

        this._body.getReferencedInputs(allInputs, result);

        return result;
    }

    protected internalPrepareForExecution(inputs: Dictionary<Input>) {
        this._url.substituteInputValues(inputs, ContentTypes.applicationXWwwFormUrlencoded);

        let contentType = ContentTypes.applicationJson;

        for (let header of this.headers) {
            header.prepareForExecution(inputs);

            if (!Utils.isNullOrEmpty(header.name) && header.name.toLowerCase() == "content-type") {
                contentType = <string>header.value;
            }
        }

        this._body.substituteInputValues(inputs, contentType);
    };

    getJsonTypeName(): string {
        return HttpAction.JsonTypeName;
    }

    internalValidateProperties(context: ValidationResults) {
        super.internalValidateProperties(context);

        if (Utils.isNullOrEmpty(this.url)) {
            context.addFailure(
                this,
                {
                    error: Enums.ValidationError.PropertyCantBeNull,
                    message: "An Action.Http must have its url property set."
                });
        }

        if (this.headers.length > 0) {
            for (let header of this.headers) {
                if (!header.name) {
                    context.addFailure(
                        this,
                        {
                            error: Enums.ValidationError.PropertyCantBeNull,
                            message: "All headers of an Action.Http must have their name and value properties set."
                        });
                }
            }
        }
    }

    get ignoreInputValidation(): boolean {
        return this._ignoreInputValidation;
    }

    set ignoreInputValidation(value: boolean) {
        this._ignoreInputValidation = value;
    }

    get url(): string | undefined {
        return this._url.get();
    }

    set url(value: string | undefined) {
        this._url.set(value);
    }

    get body(): string | undefined {
        return this._body.get();
    }

    set body(value: string | undefined) {
        this._body.set(value);
    }
}

export class ShowCardAction extends Action {
    // Note the "weird" way this field is declared is to work around a breaking
    // change introduced in TS 3.1 wrt d.ts generation. DO NOT CHANGE
    static readonly JsonTypeName: "Action.ShowCard" = "Action.ShowCard";

    protected addCssClasses(element: HTMLElement) {
        super.addCssClasses(element);

        if (this.parent) {
            element.classList.add(this.parent.hostConfig.makeCssClassName("expandable"));
        }
    }

    readonly card: AdaptiveCard = new InlineAdaptiveCard();

    getJsonTypeName(): string {
        return ShowCardAction.JsonTypeName;
    }

    toJSON(): any {
        let result = super.toJSON();

        if (this.card) {
            Utils.setProperty(result, "card", this.card.toJSON());
        }

        return result;
    }

    internalValidateProperties(context: ValidationResults) {
        super.internalValidateProperties(context);

        this.card.internalValidateProperties(context);
    }

    parse(json: any, errors?: IValidationError[]) {
        super.parse(json, errors);

        let jsonCard = json["card"];

        if (jsonCard) {
            this.card.parse(jsonCard, errors);
        }
        else {
            raiseParseError(
                {
                    error: Enums.ValidationError.PropertyCantBeNull,
                    message: "An Action.ShowCard must have its \"card\" property set to a valid AdaptiveCard object."
                },
                errors
            );
        }
    }

    updateActionButtonCssStyle(actionButtonElement: HTMLElement): void {
        super.updateActionButtonCssStyle(actionButtonElement);

        if (this.parent) {
            actionButtonElement.classList.add(this.parent.hostConfig.makeCssClassName("expandable"));
        }
    }

    setParent(value: CardElement) {
        super.setParent(value);

        this.card.setParent(value);
    }

    getAllInputs(): Input[] {
        return this.card.getAllInputs();
    }

    getResourceInformation(): IResourceInformation[] {
        return super.getResourceInformation().concat(this.card.getResourceInformation());
    }

    getActionById(id: string): Action | undefined {
        let result = super.getActionById(id);

        if (!result) {
            result = this.card.getActionById(id);
        }

        return result;
    }
}

class ActionCollection {
    private _owner: CardElement;
    private _actionCardContainer: HTMLDivElement;
    private _expandedAction?: ShowCardAction;
    private _renderedActionCount: number = 0;
    private _actionCard?: HTMLElement;

    private refreshContainer() {
        this._actionCardContainer.innerHTML = "";

        if (!this._actionCard) {
            this._actionCardContainer.style.marginTop = "0px";

            return;
        }

        this._actionCardContainer.style.marginTop = this._renderedActionCount > 0 ? this._owner.hostConfig.actions.showCard.inlineTopMargin + "px" : "0px";

        let padding = this._owner.getEffectivePadding();

        this._owner.getImmediateSurroundingPadding(padding);

        let physicalPadding = this._owner.hostConfig.paddingDefinitionToSpacingDefinition(padding);

        if (this._actionCard) {
            this._actionCard.style.paddingLeft = physicalPadding.left + "px";
            this._actionCard.style.paddingRight = physicalPadding.right + "px";

            this._actionCard.style.marginLeft = "-" + physicalPadding.left + "px";
            this._actionCard.style.marginRight = "-" + physicalPadding.right + "px";

            if (physicalPadding.bottom != 0 && !this._owner.isDesignMode()) {
                this._actionCard.style.paddingBottom = physicalPadding.bottom + "px";
                this._actionCard.style.marginBottom = "-" + physicalPadding.bottom + "px";
            }

            Utils.appendChild(this._actionCardContainer, this._actionCard);
        }
    }

    private layoutChanged() {
        this._owner.getRootElement().updateLayout();
    }

    private hideActionCard() {
        let previouslyExpandedAction = this._expandedAction;

        this._expandedAction = undefined;
        this._actionCard = undefined;

        this.refreshContainer();

        if (previouslyExpandedAction) {
            this.layoutChanged();

            raiseInlineCardExpandedEvent(previouslyExpandedAction, false);
        }
    }

    private showActionCard(action: ShowCardAction, suppressStyle: boolean = false, raiseEvent: boolean = true) {
        (<InlineAdaptiveCard>action.card).suppressStyle = suppressStyle;

        let renderedCard = action.card.render();

        this._actionCard = renderedCard;
        this._expandedAction = action;

        this.refreshContainer();

        if (raiseEvent) {
            this.layoutChanged();

            raiseInlineCardExpandedEvent(action, true);
        }
    }

    private collapseExpandedAction() {
        for (let button of this.buttons) {
            button.state = ActionButtonState.Normal;
        }

        this.hideActionCard();
    }

    private expandShowCardAction(action: ShowCardAction, raiseEvent: boolean) {
        for (let button of this.buttons) {
            if (button.action !== action) {
                button.state = ActionButtonState.Subdued;
            }
            else {
                button.state = ActionButtonState.Expanded;
            }
        }

        this.showActionCard(
            action,
            !(this._owner.isAtTheVeryLeft() && this._owner.isAtTheVeryRight()),
            raiseEvent);
    }

    private actionClicked(actionButton: ActionButton) {
        if (!(actionButton.action instanceof ShowCardAction)) {
            for (let button of this.buttons) {
                button.state = ActionButtonState.Normal;
            }

            this.hideActionCard();

            actionButton.action.execute();
        }
        else {
            if (this._owner.hostConfig.actions.showCard.actionMode === Enums.ShowCardActionMode.Popup) {
                actionButton.action.execute();
            }
            else if (actionButton.action === this._expandedAction) {
                this.collapseExpandedAction();
            }
            else {
                this.expandShowCardAction(actionButton.action, true);
            }
        }
    }

    private getParentContainer(): Container | undefined {
        if (this._owner instanceof Container) {
            return this._owner;
        }
        else {
            return this._owner.getParentContainer();
        }
    }

    private findActionButton(action: Action): ActionButton | undefined {
        for (let actionButton of this.buttons) {
            if (actionButton.action == action) {
                return actionButton;
            }
        }

        return undefined;
    }

    items: Action[] = [];
    buttons: ActionButton[] = [];

    constructor(owner: CardElement) {
        this._owner = owner;
    }

    parse(json: any, errors?: IValidationError[]) {
        this.clear();

        if (Array.isArray(json)) {
            for (let jsonAction of json) {
                let action = createActionInstance(
                    this._owner,
                    jsonAction,
                    [],
                    !this._owner.isDesignMode(),
                    errors);

                if (action) {
                    this.addAction(action);
                }
            }
        }
    }

    toJSON(): any {
        if (this.items.length > 0) {
            let result = [];

            for (let action of this.items) {
                result.push(action.toJSON());
            }

            return result;
        }
        else {
            return undefined;
        }
    }

    getActionById(id: string): Action | undefined {
        let result: Action | undefined = undefined;

        for (let item of this.items) {
            result = item.getActionById(id);

            if (result) {
                break;
            }
        }

        return result;
    }

    validateProperties(context: ValidationResults) {
        if (this._owner.hostConfig.actions.maxActions && this.items.length > this._owner.hostConfig.actions.maxActions) {
            context.addFailure(
                this._owner,
                {
                    error: Enums.ValidationError.TooManyActions,
                    message: "A maximum of " + this._owner.hostConfig.actions.maxActions + " actions are allowed."
                });
        }

        if (this.items.length > 0 && !this._owner.hostConfig.supportsInteractivity) {
            context.addFailure(
                this._owner,
                {
                    error: Enums.ValidationError.InteractivityNotAllowed,
                    message: "Interactivity is not allowed."
                });
        }

        for (let item of this.items) {
            if (!isActionAllowed(item, this._owner.getForbiddenActionTypes())) {
                context.addFailure(
                    this._owner,
                    {
                        error: Enums.ValidationError.ActionTypeNotAllowed,
                        message: "Actions of type " + item.getJsonTypeName() + " are not allowe."
                    });
            }

            item.internalValidateProperties(context);
        }
    }

    render(orientation: Enums.Orientation, isDesignMode: boolean): HTMLElement | undefined {
        // Cache hostConfig for better perf
        let hostConfig = this._owner.hostConfig;

        if (!hostConfig.supportsInteractivity) {
            return undefined;
        }

        let element = document.createElement("div");
        let maxActions = hostConfig.actions.maxActions ? Math.min(hostConfig.actions.maxActions, this.items.length) : this.items.length;
        let forbiddenActionTypes = this._owner.getForbiddenActionTypes();

        this._actionCardContainer = document.createElement("div");
        this._renderedActionCount = 0;

        if (hostConfig.actions.preExpandSingleShowCardAction && maxActions == 1 && this.items[0] instanceof ShowCardAction && isActionAllowed(this.items[0], forbiddenActionTypes)) {
            this.showActionCard(<ShowCardAction>this.items[0], true);
            this._renderedActionCount = 1;
        }
        else {
            let buttonStrip = document.createElement("div");
            buttonStrip.className = hostConfig.makeCssClassName("ac-actionSet");
            buttonStrip.style.display = "flex";

            if (orientation == Enums.Orientation.Horizontal) {
                buttonStrip.style.flexDirection = "row";

                if (this._owner.horizontalAlignment && hostConfig.actions.actionAlignment != Enums.ActionAlignment.Stretch) {
                    switch (this._owner.horizontalAlignment) {
                        case Enums.HorizontalAlignment.Center:
                            buttonStrip.style.justifyContent = "center";
                            break;
                        case Enums.HorizontalAlignment.Right:
                            buttonStrip.style.justifyContent = "flex-end";
                            break;
                        default:
                            buttonStrip.style.justifyContent = "flex-start";
                            break;
                    }
                }
                else {
                    switch (hostConfig.actions.actionAlignment) {
                        case Enums.ActionAlignment.Center:
                            buttonStrip.style.justifyContent = "center";
                            break;
                        case Enums.ActionAlignment.Right:
                            buttonStrip.style.justifyContent = "flex-end";
                            break;
                        default:
                            buttonStrip.style.justifyContent = "flex-start";
                            break;
                    }
                }
            }
            else {
                buttonStrip.style.flexDirection = "column";

                if (this._owner.horizontalAlignment && hostConfig.actions.actionAlignment != Enums.ActionAlignment.Stretch) {
                    switch (this._owner.horizontalAlignment) {
                        case Enums.HorizontalAlignment.Center:
                            buttonStrip.style.alignItems = "center";
                            break;
                        case Enums.HorizontalAlignment.Right:
                            buttonStrip.style.alignItems = "flex-end";
                            break;
                        default:
                            buttonStrip.style.alignItems = "flex-start";
                            break;
                    }
                }
                else {
                    switch (hostConfig.actions.actionAlignment) {
                        case Enums.ActionAlignment.Center:
                            buttonStrip.style.alignItems = "center";
                            break;
                        case Enums.ActionAlignment.Right:
                            buttonStrip.style.alignItems = "flex-end";
                            break;
                        case Enums.ActionAlignment.Stretch:
                            buttonStrip.style.alignItems = "stretch";
                            break;
                        default:
                            buttonStrip.style.alignItems = "flex-start";
                            break;
                    }
                }
            }

            let parentContainer = this.getParentContainer();

            if (parentContainer) {
                let parentContainerStyle = parentContainer.getEffectiveStyle();

                for (let i = 0; i < this.items.length; i++) {
                    if (isActionAllowed(this.items[i], forbiddenActionTypes)) {
                        let actionButton = this.findActionButton(this.items[i]);

                        if (!actionButton) {
                            actionButton = new ActionButton(this.items[i], parentContainerStyle);
                            actionButton.onClick = (ab) => { this.actionClicked(ab); };

                            this.buttons.push(actionButton);
                        }

                        actionButton.render();

                        if (actionButton.action.renderedElement) {
                            if (hostConfig.actions.actionsOrientation == Enums.Orientation.Horizontal && hostConfig.actions.actionAlignment == Enums.ActionAlignment.Stretch) {
                                actionButton.action.renderedElement.style.flex = "0 1 100%";
                            }
                            else {
                                actionButton.action.renderedElement.style.flex = "0 1 auto";
                            }

                            buttonStrip.appendChild(actionButton.action.renderedElement);

                            this._renderedActionCount++;

                            if (this._renderedActionCount >= hostConfig.actions.maxActions || i == this.items.length - 1) {
                                break;
                            }
                            else if (hostConfig.actions.buttonSpacing > 0) {
                                let spacer = document.createElement("div");

                                if (orientation === Enums.Orientation.Horizontal) {
                                    spacer.style.flex = "0 0 auto";
                                    spacer.style.width = hostConfig.actions.buttonSpacing + "px";
                                }
                                else {
                                    spacer.style.height = hostConfig.actions.buttonSpacing + "px";
                                }

                                Utils.appendChild(buttonStrip, spacer);
                            }
                        }
                    }
                }
            }

            let buttonStripContainer = document.createElement("div");
            buttonStripContainer.style.overflow = "hidden";
            buttonStripContainer.appendChild(buttonStrip);

            Utils.appendChild(element, buttonStripContainer);
        }

        Utils.appendChild(element, this._actionCardContainer);

        for (let button of this.buttons) {
            if (button.state == ActionButtonState.Expanded) {
                this.expandShowCardAction(<ShowCardAction>button.action, false);

                break;
            }
        }

        return this._renderedActionCount > 0 ? element : undefined;
    }

    addAction(action: Action) {
        if (!action) {
            throw new Error("The action parameter cannot be null.");
        }

        if ((!action.parent || action.parent === this._owner) && this.items.indexOf(action) < 0) {
            this.items.push(action);

            if (!action.parent) {
                action.setParent(this._owner);
            }

            action["_actionCollection"] = this;
        }
        else {
            throw new Error("The action already belongs to another element.");
        }
    }

    removeAction(action: Action): boolean {
        if (this.expandedAction && this._expandedAction == action) {
            this.collapseExpandedAction();
        }

        let actionIndex = this.items.indexOf(action);

        if (actionIndex >= 0) {
            this.items.splice(actionIndex, 1);

            action.setParent(undefined);

            action["_actionCollection"] = undefined;

            for (let i = 0; i < this.buttons.length; i++) {
                if (this.buttons[i].action == action) {
                    this.buttons.splice(i, 1);

                    break;
                }
            }

            return true;
        }

        return false;
    }

    clear() {
        this.items = [];
        this.buttons = [];

        this._expandedAction = undefined;
        this._renderedActionCount = 0;
    }

    getAllInputs(): Input[] {
        let result: Input[] = [];

        for (let action of this.items) {
            result = result.concat(action.getAllInputs());
        }

        return result;
    }

    getResourceInformation(): IResourceInformation[] {
        let result: IResourceInformation[] = [];

        for (let action of this.items) {
            result = result.concat(action.getResourceInformation());
        }

        return result;
    }

    get renderedActionCount(): number {
        return this._renderedActionCount;
    }

    get expandedAction(): ShowCardAction | undefined {
        return this._expandedAction;
    }
}

export class ActionSet extends CardElement {
    //#region Schema

    static readonly orientationProperty = new EnumProperty(Versions.v1_1, "orientation", Enums.Orientation);

    @property(ActionSet.orientationProperty)
    orientation?: Enums.Orientation;

    //#endregion

    private _actionCollection: ActionCollection;

    protected internalRender(): HTMLElement | undefined {
        return this._actionCollection.render(this.orientation !== undefined ? this.orientation : this.hostConfig.actions.actionsOrientation, this.isDesignMode());
    }

    constructor() {
        super();

        this._actionCollection = new ActionCollection(this);
    }

    parse(json: any, errors?: IValidationError[]) {
        super.parse(json, errors);

        this._actionCollection.parse(json["actions"], errors);
    }

    toJSON(): any {
        let result = super.toJSON();

        Utils.setProperty(result, "actions", this._actionCollection.toJSON());

        return result;
    }

    isBleedingAtBottom(): boolean {
        if (this._actionCollection.renderedActionCount == 0) {
            return super.isBleedingAtBottom();
        }
        else {
            if (this._actionCollection.items.length == 1) {
                return this._actionCollection.expandedAction !== undefined && !this.hostConfig.actions.preExpandSingleShowCardAction;
            }
            else {
                return this._actionCollection.expandedAction !== undefined;
            }
        }
    }

    getJsonTypeName(): string {
        return "ActionSet";
    }

    getActionCount(): number {
        return this._actionCollection.items.length;
    }

    getActionAt(index: number): Action | undefined {
        if (index >= 0 && index < this.getActionCount()) {
            return this._actionCollection.items[index];
        }
        else {
            return super.getActionAt(index);
        }
    }

    internalValidateProperties(context: ValidationResults) {
        super.internalValidateProperties(context);

        this._actionCollection.validateProperties(context);
    }

    addAction(action: Action) {
        this._actionCollection.addAction(action);
    }

    getAllInputs(): Input[] {
        return this._actionCollection.getAllInputs();
    }

    getResourceInformation(): IResourceInformation[] {
        return this._actionCollection.getResourceInformation();
    }

    get isInteractive(): boolean {
        return true;
    }
}

export abstract class StylableCardElementContainer extends CardElementContainer {
    //#region Schema

    static readonly styleProperty = new ValueSetProperty(
        Versions.v1_0,
        "style",
        [
            { value: Enums.ContainerStyle.Default },
            { value: Enums.ContainerStyle.Emphasis },
            { targetVersion: Versions.v1_2, value: Enums.ContainerStyle.Accent },
            { targetVersion: Versions.v1_2, value: Enums.ContainerStyle.Good },
            { targetVersion: Versions.v1_2, value: Enums.ContainerStyle.Attention },
            { targetVersion: Versions.v1_2, value: Enums.ContainerStyle.Warning }
        ]);
    static readonly bleedProperty = new BoolProperty(Versions.v1_1, "bleed", false);

    @property(StylableCardElementContainer.styleProperty)
    get style(): string | undefined {
        if (this.allowCustomStyle) {
            let style = this.getValue(StylableCardElementContainer.styleProperty);

            if (style && this.hostConfig.containerStyles.getStyleByName(style)) {
                return style;
            }
        }

        return undefined;
    }

    set style(value: string | undefined) {
        this.setValue(StylableCardElementContainer.styleProperty, value);
    }

    @property(StylableCardElementContainer.bleedProperty)
    private _bleed: boolean = false;

    //#endregion

    protected applyBackground() {
        if (this.renderedElement) {
            let styleDefinition = this.hostConfig.containerStyles.getStyleByName(this.style, this.hostConfig.containerStyles.getStyleByName(this.defaultStyle));

            if (!Utils.isNullOrEmpty(styleDefinition.backgroundColor)) {
                this.renderedElement.style.backgroundColor = <string>Utils.stringToCssColor(styleDefinition.backgroundColor);
            }
        }
    }

    protected applyPadding() {
        super.applyPadding();

        if (!this.renderedElement) {
            return;
        }

        let physicalPadding = new SpacingDefinition();

        if (this.getEffectivePadding()) {
            physicalPadding = this.hostConfig.paddingDefinitionToSpacingDefinition(this.getEffectivePadding());
        }

        this.renderedElement.style.paddingTop = physicalPadding.top + "px";
        this.renderedElement.style.paddingRight = physicalPadding.right + "px";
        this.renderedElement.style.paddingBottom = physicalPadding.bottom + "px";
        this.renderedElement.style.paddingLeft = physicalPadding.left + "px";

        if (this.isBleeding()) {
            // Bleed into the first parent that does have padding
            let padding = new PaddingDefinition();

            this.getImmediateSurroundingPadding(padding);

            let surroundingPadding = this.hostConfig.paddingDefinitionToSpacingDefinition(padding);

            this.renderedElement.style.marginRight = "-" + surroundingPadding.right + "px";
            this.renderedElement.style.marginLeft = "-" + surroundingPadding.left + "px";

            if (!this.isDesignMode()) {
                this.renderedElement.style.marginTop = "-" + surroundingPadding.top + "px";
                this.renderedElement.style.marginBottom = "-" + surroundingPadding.bottom + "px";
            }

            if (this.separatorElement && this.separatorOrientation == Enums.Orientation.Horizontal) {
                this.separatorElement.style.marginLeft = "-" + surroundingPadding.left + "px";
                this.separatorElement.style.marginRight = "-" + surroundingPadding.right + "px";
            }
        }
        else {
            this.renderedElement.style.marginRight = "0";
            this.renderedElement.style.marginLeft = "0";
            this.renderedElement.style.marginTop = "0";
            this.renderedElement.style.marginBottom = "0";

            if (this.separatorElement) {
                this.separatorElement.style.marginRight = "0";
                this.separatorElement.style.marginLeft = "0";
            }
        }
    }

    protected getHasBackground(): boolean {
        let currentElement: CardElement | undefined = this.parent;

        while (currentElement) {
            let currentElementHasBackgroundImage = currentElement instanceof Container ? currentElement.backgroundImage.isValid() : false;

            if (currentElement instanceof StylableCardElementContainer) {
                if (this.hasExplicitStyle && (currentElement.getEffectiveStyle() != this.getEffectiveStyle() || currentElementHasBackgroundImage)) {
                    return true;
                }
            }

            currentElement = currentElement.parent;
        }

        return false;
    }

    protected getDefaultPadding(): PaddingDefinition {
        return this.getHasBackground() ?
            new PaddingDefinition(
                Enums.Spacing.Padding,
                Enums.Spacing.Padding,
                Enums.Spacing.Padding,
                Enums.Spacing.Padding) : super.getDefaultPadding();
    }

    protected getHasExpandedAction(): boolean {
        return false;
    }

    protected getBleed(): boolean {
        return this._bleed;
    }

    protected setBleed(value: boolean) {
        this._bleed = value;
    }

    protected get renderedActionCount(): number {
        return 0;
    }

    protected get hasExplicitStyle(): boolean {
        return this.getValue(StylableCardElementContainer.styleProperty) !== undefined;
    }

    protected get allowCustomStyle(): boolean {
        return true;
    }

    protected get supportsMinHeight(): boolean {
        return true;
    }

    isBleeding(): boolean {
		return (this.getHasBackground() || this.hostConfig.alwaysAllowBleed) && this.getBleed();
    }

    internalValidateProperties(context: ValidationResults) {
        super.internalValidateProperties(context);

        let explicitStyle = this.getValue(StylableCardElementContainer.styleProperty);

        if (explicitStyle !== undefined) {
            let styleDefinition = this.hostConfig.containerStyles.getStyleByName(explicitStyle);

            if (!styleDefinition) {
                context.addFailure(
                    this,
                    {
                        error: Enums.ValidationError.InvalidPropertyValue,
                        message: "Unknown container style: " + explicitStyle
                    });
            }
        }
    }

    render(): HTMLElement | undefined {
        let renderedElement = super.render();

        if (renderedElement && this.getHasBackground()) {
            this.applyBackground();
        }

        return renderedElement;
    }

    getEffectiveStyle(): string {
        let effectiveStyle = this.style;

        return effectiveStyle ? effectiveStyle : super.getEffectiveStyle();
    }
}

export class BackgroundImage extends SerializableObject {
    //#region Schema

    static readonly urlProperty = new StringProperty(Versions.v1_0, "url");
    static readonly fillModeProperty = new EnumProperty(Versions.v1_2, "fillMode", Enums.FillMode, Enums.FillMode.Cover);
    static readonly horizontalAlignmentProperty = new EnumProperty(Versions.v1_2, "horizontalAlignment", Enums.HorizontalAlignment, Enums.HorizontalAlignment.Left);
    static readonly verticalAlignmentProperty = new EnumProperty(Versions.v1_2, "verticalAlignment", Enums.VerticalAlignment, Enums.VerticalAlignment.Top);

    @property(BackgroundImage.urlProperty)
    url?: string;

    @property(BackgroundImage.fillModeProperty)
    fillMode: Enums.FillMode;

    @property(BackgroundImage.horizontalAlignmentProperty)
    horizontalAlignment: Enums.HorizontalAlignment;

    @property(BackgroundImage.verticalAlignmentProperty)
    verticalAlignment: Enums.VerticalAlignment;

    //#endregion

    protected getSchemaKey(): string {
        return "BackgroundImage";
    }

    parse(source: any, errors?: IValidationError[]) {
        if (typeof source === "string") {
            this.resetDefaultValues();
            this.url = source;
        }
        else {
            return super.parse(source, errors);
        }
    }

    toJSON(): any {
        if (!this.isValid()) {
            return undefined;
        }

        if (this.hasDefaultValue(BackgroundImage.fillModeProperty) &&
            this.hasDefaultValue(BackgroundImage.horizontalAlignmentProperty) &&
            this.hasDefaultValue(BackgroundImage.verticalAlignmentProperty)) {

            return this.url;
        }
        else {
            return super.toJSON();
        }
    }

    apply(element: HTMLElement) {
        if (this.url) {
            element.style.backgroundImage = "url('" + this.url + "')";

            switch (this.fillMode) {
                case Enums.FillMode.Repeat:
                    element.style.backgroundRepeat = "repeat";
                    break;
                case Enums.FillMode.RepeatHorizontally:
                    element.style.backgroundRepeat = "repeat-x";
                    break;
                case Enums.FillMode.RepeatVertically:
                    element.style.backgroundRepeat = "repeat-y";
                    break;
                case Enums.FillMode.Cover:
                default:
                    element.style.backgroundRepeat = "no-repeat";
                    element.style.backgroundSize = "cover";
                    break;
            }

            switch (this.horizontalAlignment) {
                case Enums.HorizontalAlignment.Center:
                    element.style.backgroundPositionX = "center";
                    break;
                case Enums.HorizontalAlignment.Right:
                    element.style.backgroundPositionX = "right";
                    break;
            }

            switch (this.verticalAlignment) {
                case Enums.VerticalAlignment.Center:
                    element.style.backgroundPositionY = "center";
                    break;
                case Enums.VerticalAlignment.Bottom:
                    element.style.backgroundPositionY = "bottom";
                    break;
            }
        }
    }

    isValid(): boolean {
        return !Utils.isNullOrEmpty(this.url);
    }
}

export class Container extends StylableCardElementContainer {
    //#region Schema

    static readonly backgroundImageProperty = new SerializableObjectProperty(
        Versions.v1_0,
        "backgroundImage",
        BackgroundImage);
    static readonly verticalContentAlignmentProperty = new EnumProperty(Versions.v1_1, "verticalContentAlignment", Enums.VerticalAlignment, Enums.VerticalAlignment.Top);
    static readonly rtlProperty = new BoolProperty(Versions.v1_0, "rtl");

    @property(Container.backgroundImageProperty)
    get backgroundImage(): BackgroundImage {
        return this.getValue(Container.backgroundImageProperty);
    }

    @property(Container.verticalContentAlignmentProperty)
    verticalContentAlignment: Enums.VerticalAlignment = Enums.VerticalAlignment.Top;

    @property(Container.rtlProperty)
    rtl?: boolean;

    //#endregion

    private _items: CardElement[] = [];
    private _renderedItems: CardElement[] = [];

    private insertItemAt(
        item: CardElement,
        index: number,
        forceInsert: boolean) {
        if (!item.parent || forceInsert) {
            if (item.isStandalone) {
                if (index < 0 || index >= this._items.length) {
                    this._items.push(item);
                }
                else {
                    this._items.splice(index, 0, item);
                }

                item.setParent(this);
            }
            else {
                throw new Error("Elements of type " + item.getJsonTypeName() + " cannot be used as standalone elements.");
            }
        }
        else {
            throw new Error("The element already belongs to another container.")
        }
    }

    protected supportsExcplitiHeight(): boolean {
        return true;
    }

    protected getItemsCollectionPropertyName(): string {
        return "items";
    }

    protected applyBackground() {
        if (this.backgroundImage.isValid() && this.renderedElement) {
            this.backgroundImage.apply(this.renderedElement);
        }

        super.applyBackground();
    }

    protected internalRender(): HTMLElement | undefined {
        this._renderedItems = [];

        // Cache hostConfig to avoid walking the parent hierarchy several times
        let hostConfig = this.hostConfig;

        let element = document.createElement("div");

        if (this.rtl !== undefined && this.rtl) {
            element.dir = "rtl";
        }

        element.classList.add(hostConfig.makeCssClassName("ac-container"));
        element.style.display = "flex";
        element.style.flexDirection = "column";

        if (GlobalSettings.useAdvancedCardBottomTruncation) {
            // Forces the container to be at least as tall as its content.
            //
            // Fixes a quirk in Chrome where, for nested flex elements, the
            // inner element's height would never exceed the outer element's
            // height. This caused overflow truncation to break -- containers
            // would always be measured as not overflowing, since their heights
            // were constrained by their parents as opposed to truly reflecting
            // the height of their content.
            //
            // See the "Browser Rendering Notes" section of this answer:
            // https://stackoverflow.com/questions/36247140/why-doesnt-flex-item-shrink-past-content-size
            element.style.minHeight = '-webkit-min-content';
        }

        switch (this.verticalContentAlignment) {
            case Enums.VerticalAlignment.Center:
                element.style.justifyContent = "center";
                break;
            case Enums.VerticalAlignment.Bottom:
                element.style.justifyContent = "flex-end";
                break;
            default:
                element.style.justifyContent = "flex-start";
                break;
        }

        if (this._items.length > 0) {
            for (let item of this._items) {
                let renderedItem = this.isElementAllowed(item, this.getForbiddenElementTypes()) ? item.render() : undefined;

                if (renderedItem) {
                    if (this._renderedItems.length > 0 && item.separatorElement) {
                        item.separatorElement.style.flex = "0 0 auto";

                        Utils.appendChild(element, item.separatorElement);
                    }

                    Utils.appendChild(element, renderedItem);

                    this._renderedItems.push(item);
                }
            }
        }
        else {
            if (this.isDesignMode()) {
                let placeholderElement = this.createPlaceholderElement();
                placeholderElement.style.width = "100%";
                placeholderElement.style.height = "100%";

                element.appendChild(placeholderElement);
            }
        }

        return element;
    }

    protected truncateOverflow(maxHeight: number): boolean {
        if (this.renderedElement) {
            // Add 1 to account for rounding differences between browsers
            let boundary = this.renderedElement.offsetTop + maxHeight + 1;

            let handleElement = (cardElement: CardElement) => {
                let elt = cardElement.renderedElement;

                if (elt) {
                    switch (Utils.getFitStatus(elt, boundary)) {
                        case Enums.ContainerFitStatus.FullyInContainer:
                            let sizeChanged = cardElement['resetOverflow']();
                            // If the element's size changed after resetting content,
                            // we have to check if it still fits fully in the card
                            if (sizeChanged) {
                                handleElement(cardElement);
                            }
                            break;
                        case Enums.ContainerFitStatus.Overflowing:
                            let maxHeight = boundary - elt.offsetTop;
                            cardElement['handleOverflow'](maxHeight);
                            break;
                        case Enums.ContainerFitStatus.FullyOutOfContainer:
                            cardElement['handleOverflow'](0);
                            break;
                    }
                }
            };

            for (let item of this._items) {
                handleElement(item);
            }

            return true;
        }

        return false;
    }

    protected undoOverflowTruncation() {
        for (let item of this._items) {
            item['resetOverflow']();
        }
    }

    protected getHasBackground(): boolean {
        return this.backgroundImage.isValid() || super.getHasBackground();
    }

    protected get isSelectable(): boolean {
        return true;
    }

    parse(json: any, errors?: IValidationError[]) {
        super.parse(json, errors);

        this.clear();
        this.setShouldFallback(false);

        let jsonItems = json[this.getItemsCollectionPropertyName()];

        if (Array.isArray(jsonItems)) {
            for (let item of jsonItems) {
                let element = createElementInstance(
                    this,
                    item,
                    !this.isDesignMode(),
                    errors);

                if (element) {
                    this.insertItemAt(element, -1, true);
                }
            }
        }
    }

    toJSON(): any {
        let result = super.toJSON();

        Utils.setArrayProperty(result, this.getItemsCollectionPropertyName(), this._items);

        return result;
    }

    getItemCount(): number {
        return this._items.length;
    }

    getItemAt(index: number): CardElement {
        return this._items[index];
    }

    getFirstVisibleRenderedItem(): CardElement | undefined {
        if (this.renderedElement && this._renderedItems && this._renderedItems.length > 0) {
            for (let item of this._renderedItems) {
                if (item.isVisible) {
                    return item;
                }
            };
        }

        return undefined;
    }

    getLastVisibleRenderedItem(): CardElement | undefined {
        if (this.renderedElement && this._renderedItems && this._renderedItems.length > 0) {
            for (let i = this._renderedItems.length - 1; i >= 0; i--) {
                if (this._renderedItems[i].isVisible) {
                    return this._renderedItems[i];
                }
            }
        }

        return undefined;
    }

    getJsonTypeName(): string {
        return "Container";
    }

    isFirstElement(element: CardElement): boolean {
        let designMode = this.isDesignMode();

        for (let item of this._items) {
            if (item.isVisible || designMode) {
                return item == element;
            }
        }

        return false;
    }

    isLastElement(element: CardElement): boolean {
        let designMode = this.isDesignMode();

        for (let i = this._items.length - 1; i >= 0; i--) {
            if (this._items[i].isVisible || designMode) {
                return this._items[i] == element;
            }
        }

        return false;
    }

    isRtl(): boolean {
        if (this.rtl !== undefined) {
            return this.rtl;
        }
        else {
            let parentContainer = this.getParentContainer();

            return parentContainer ? parentContainer.isRtl() : false;
        }
    }

    isBleedingAtTop(): boolean {
        let firstRenderedItem = this.getFirstVisibleRenderedItem();

        return this.isBleeding() || (firstRenderedItem ? firstRenderedItem.isBleedingAtTop() : false);
    }

    isBleedingAtBottom(): boolean {
        let lastRenderedItem = this.getLastVisibleRenderedItem();

        return this.isBleeding() || (lastRenderedItem ? lastRenderedItem.isBleedingAtBottom() && lastRenderedItem.getEffectiveStyle() == this.getEffectiveStyle() : false);
    }

    indexOf(cardElement: CardElement): number {
        return this._items.indexOf(cardElement);
    }

    addItem(item: CardElement) {
        this.insertItemAt(item, -1, false);
    }

    insertItemBefore(item: CardElement, insertBefore: CardElement) {
        this.insertItemAt(item, this._items.indexOf(insertBefore), false);
    }

    insertItemAfter(item: CardElement, insertAfter: CardElement) {
        this.insertItemAt(item, this._items.indexOf(insertAfter) + 1, false);
    }

    removeItem(item: CardElement): boolean {
        let itemIndex = this._items.indexOf(item);

        if (itemIndex >= 0) {
            this._items.splice(itemIndex, 1);

            item.setParent(undefined);

            this.updateLayout();

            return true;
        }

        return false;
    }

    clear() {
        this._items = [];
        this._renderedItems = [];
    }

    getResourceInformation(): IResourceInformation[] {
        let result = super.getResourceInformation();

        if (this.backgroundImage.isValid()) {
            result.push(
                {
                    url: <string>this.backgroundImage.url,
                    mimeType: "image"
                }
            );
        }

        return result;
    }

    getActionById(id: string): Action | undefined {
        let result: Action | undefined = super.getActionById(id);

        if (!result) {
            if (this.selectAction) {
                result = this.selectAction.getActionById(id);
            }

            if (!result) {
                for (let item of this._items) {
                    result = item.getActionById(id);

                    if (result) {
                        break;
                    }
                }
            }
        }

        return result;
    }

    get padding(): PaddingDefinition | undefined {
        return this.getPadding();
    }

    set padding(value: PaddingDefinition | undefined) {
        this.setPadding(value);
    }

    get selectAction(): Action | undefined {
        return this._selectAction;
    }

    set selectAction(value: Action | undefined) {
        this._selectAction = value;
    }

    get bleed(): boolean {
        return this.getBleed();
    }

    set bleed(value: boolean) {
        this.setBleed(value);
    }
}

export type ColumnWidth = SizeAndUnit | "auto" | "stretch";

export class Column extends Container {
    //#region Schema

    static readonly widthProperty = new CustomProperty<ColumnWidth>(
        Versions.v1_0,
        "width",
        (sender: SerializableObject, property: PropertyDefinition, source: PropertyBag, errors?: IValidationError[]) => {
            let result: ColumnWidth = property.defaultValue;
            let value = source[property.name];
            let invalidWidth = false;
    
            if (typeof value === "number" && !isNaN(value)) {
                result = new SizeAndUnit(value, Enums.SizeUnit.Weight);
            }
            else if (value === "auto" || value === "stretch") {
                result = value;
            }
            // TODO: Check for version before parsing pixel width
            else if (typeof value === "string") {
                try {
                    result = SizeAndUnit.parse(value);
                }
                catch (e) {
                    invalidWidth = true;
                }    
            }
            else {
                invalidWidth = true;
            }

            if (invalidWidth) {
                raiseParseError(
                    {
                        error: Enums.ValidationError.InvalidPropertyValue,
                        message: "Invalid column width:" + value + " - defaulting to \"auto\""
                    },
                    errors
                );
            }

            return result;
        },
        (sender: SerializableObject, property: PropertyDefinition, target: PropertyBag, value: ColumnWidth) => {
            if (value instanceof SizeAndUnit) {
                if (value.unit === Enums.SizeUnit.Pixel) {
                    Utils.setProperty(target, "width", value.physicalSize + "px");
                }
                else {
                    Utils.setNumberProperty(target, "width", value.physicalSize);
                }
            }
            else {
                Utils.setProperty(target, "width", value);
            }
        });

    @property(Column.widthProperty)
    width: ColumnWidth = "auto";

    //#endregion

    private _computedWeight: number = 0;

    protected adjustRenderedElementSize(renderedElement: HTMLElement) {
        const minDesignTimeColumnHeight = 20;

        if (this.isDesignMode()) {
            renderedElement.style.minWidth = "20px";
            renderedElement.style.minHeight = (!this.minPixelHeight ? minDesignTimeColumnHeight : Math.max(this.minPixelHeight, minDesignTimeColumnHeight)) + "px";
        }
        else {
            renderedElement.style.minWidth = "0";

            if (this.minPixelHeight) {
                renderedElement.style.minHeight = this.minPixelHeight + "px";
            }
        }

        if (this.width === "auto") {
            renderedElement.style.flex = "0 1 auto";
        }
        else if (this.width === "stretch") {
            renderedElement.style.flex = "1 1 50px";
        }
        else {
            let sizeAndUnit = <SizeAndUnit>this.width;

            if (sizeAndUnit.unit == Enums.SizeUnit.Pixel) {
                renderedElement.style.flex = "0 0 auto";
                renderedElement.style.width = sizeAndUnit.physicalSize + "px";
            }
            else {
                renderedElement.style.flex = "1 1 " + (this._computedWeight > 0 ? this._computedWeight : sizeAndUnit.physicalSize) + "%";
            }
        }
    }

    protected get separatorOrientation(): Enums.Orientation {
        return Enums.Orientation.Vertical;
    }

    constructor(width: ColumnWidth = "auto") {
        super();

        this.width = width;
    }

    getJsonTypeName(): string {
        return "Column";
    }

    get hasVisibleSeparator(): boolean {
        if (this.parent && this.parent instanceof ColumnSet) {
            return this.separatorElement !== undefined && !this.parent.isLeftMostElement(this);
        }
        else {
            return false;
        }
    }

    get isStandalone(): boolean {
        return false;
    }
}

export class ColumnSet extends StylableCardElementContainer {
    private _columns: Column[] = [];
    private _renderedColumns: Column[];

    private createColumnInstance(json: any, errors: IValidationError[] | undefined): Column | undefined {
        return createCardObjectInstance<Column>(
            this,
            json,
            [], // Forbidden types not supported for elements for now
            !this.isDesignMode(),
            (typeName: string) => {
                return !typeName || typeName === "Column" ? new Column() : undefined;
            },
            (typeName: string, errorType: InstanceCreationErrorType) => {
                if (errorType == InstanceCreationErrorType.UnknownType) {
                    return {
                        error: Enums.ValidationError.UnknownElementType,
                        message: "Unknown element type: " + typeName + ". Fallback will be used if present."
                    }
                }
                else {
                    return {
                        error: Enums.ValidationError.ElementTypeNotAllowed,
                        message: "Element type " + typeName + " isn't allowed in a ColumnSet."
                    }
                }
            },
            errors);
    }

    protected internalRender(): HTMLElement | undefined {
        this._renderedColumns = [];

        if (this._columns.length > 0) {
            // Cache hostConfig to avoid walking the parent hierarchy several times
            let hostConfig = this.hostConfig;

            let element = document.createElement("div");
            element.className = hostConfig.makeCssClassName("ac-columnSet");
            element.style.display = "flex";

            if (GlobalSettings.useAdvancedCardBottomTruncation) {
                // See comment in Container.internalRender()
                element.style.minHeight = '-webkit-min-content';
            }

            switch (this.horizontalAlignment) {
                case Enums.HorizontalAlignment.Center:
                    element.style.justifyContent = "center";
                    break;
                case Enums.HorizontalAlignment.Right:
                    element.style.justifyContent = "flex-end";
                    break;
                default:
                    element.style.justifyContent = "flex-start";
                    break;
            }

            let totalWeight: number = 0;

            for (let column of this._columns) {
                if (column.width instanceof SizeAndUnit && (column.width.unit == Enums.SizeUnit.Weight)) {
                    totalWeight += column.width.physicalSize;
                }
            }

            for (let column of this._columns) {
                if (column.width instanceof SizeAndUnit && column.width.unit == Enums.SizeUnit.Weight && totalWeight > 0) {
                    let computedWeight = 100 / totalWeight * column.width.physicalSize;

                    // Best way to emulate "internal" access I know of
                    column["_computedWeight"] = computedWeight;
                }

                let renderedColumn = column.render();

                if (renderedColumn) {
                    if (this._renderedColumns.length > 0 && column.separatorElement) {
                        column.separatorElement.style.flex = "0 0 auto";

                        Utils.appendChild(element, column.separatorElement);
                    }

                    Utils.appendChild(element, renderedColumn);

                    this._renderedColumns.push(column);
                }
            }

            return this._renderedColumns.length > 0 ? element : undefined;
        }
        else {
            return undefined;
        }
    }

    protected truncateOverflow(maxHeight: number): boolean {
        for (let column of this._columns) {
            column['handleOverflow'](maxHeight);
        }

        return true;
    }

    protected undoOverflowTruncation() {
        for (let column of this._columns) {
            column['resetOverflow']();
        }
    }

    protected get isSelectable(): boolean {
        return true;
    }

    parse(json: any, errors?: IValidationError[]) {
        super.parse(json, errors);

        this._columns = [];
        this._renderedColumns = [];

        let jsonColumns = json["columns"];

        if (Array.isArray(jsonColumns)) {
            for (let item of jsonColumns) {
                let column = this.createColumnInstance(item, errors);

                if (column) {
                    this._columns.push(column);
                }
            }
        }
    }

    toJSON(): any {
        let result = super.toJSON();

        Utils.setArrayProperty(result, "columns", this._columns);

        return result;
    }

    isFirstElement(element: CardElement): boolean {
        for (let column of this._columns) {
            if (column.isVisible) {
                return column == element;
            }
        }

        return false;
    }

    isBleedingAtTop(): boolean {
        if (this.isBleeding()) {
            return true;
        }

        if (this._renderedColumns && this._renderedColumns.length > 0) {
            for (let column of this._columns) {
                if (column.isBleedingAtTop()) {
                    return true;
                }
            }
        }

        return false;
    }

    isBleedingAtBottom(): boolean {
        if (this.isBleeding()) {
            return true;
        }

        if (this._renderedColumns && this._renderedColumns.length > 0) {
            for (let column of this._columns) {
                if (column.isBleedingAtBottom()) {
                    return true;
                }
            }
        }

        return false;
    }

    getCount(): number {
        return this._columns.length;
    }

    getItemCount(): number {
        return this.getCount();
    }

    getFirstVisibleRenderedItem(): CardElement | undefined {
        if (this.renderedElement && this._renderedColumns && this._renderedColumns.length > 0) {
            return this._renderedColumns[0];
        }
        else {
            return undefined;
        }
    }

    getLastVisibleRenderedItem(): CardElement | undefined {
        if (this.renderedElement && this._renderedColumns && this._renderedColumns.length > 0) {
            return this._renderedColumns[this._renderedColumns.length - 1];
        }
        else {
            return undefined;
        }
    }

    getColumnAt(index: number): Column {
        return this._columns[index];
    }

    getItemAt(index: number): CardElement {
        return this.getColumnAt(index);
    }

    getJsonTypeName(): string {
        return "ColumnSet";
    }

    internalValidateProperties(context: ValidationResults) {
        super.internalValidateProperties(context);

        let weightedColumns: number = 0;
        let stretchedColumns: number = 0;

        for (let column of this._columns) {
            if (typeof column.width === "number") {
                weightedColumns++;
            }
            else if (column.width === "stretch") {
                stretchedColumns++;
            }
        }

        if (weightedColumns > 0 && stretchedColumns > 0) {
            context.addFailure(
                this,
                {
                    error: Enums.ValidationError.Hint,
                    message: "It is not recommended to use weighted and stretched columns in the same ColumnSet, because in such a situation stretched columns will always get the minimum amount of space."
                });
        }
    }

    addColumn(column: Column) {
        if (!column.parent) {
            this._columns.push(column);

            column.setParent(this);
        }
        else {
            throw new Error("This column already belongs to another ColumnSet.");
        }
    }

    removeItem(item: CardElement): boolean {
        if (item instanceof Column) {
            let itemIndex = this._columns.indexOf(item);

            if (itemIndex >= 0) {
                this._columns.splice(itemIndex, 1);

                item.setParent(undefined);

                this.updateLayout();

                return true;
            }
        }

        return false;
    }

    indexOf(cardElement: CardElement): number {
        return cardElement instanceof Column ? this._columns.indexOf(cardElement) : -1;
    }

    isLeftMostElement(element: CardElement): boolean {
        return this._columns.indexOf(<Column>element) == 0;
    }

    isRightMostElement(element: CardElement): boolean {
        return this._columns.indexOf(<Column>element) == this._columns.length - 1;
    }

    isTopElement(element: CardElement): boolean {
        return this._columns.indexOf(<Column>element) >= 0;
    }

    isBottomElement(element: CardElement): boolean {
        return this._columns.indexOf(<Column>element) >= 0;
    }

    getActionById(id: string): Action | undefined {
        let result: Action | undefined = undefined;

        for (let column of this._columns) {
            result = column.getActionById(id);

            if (result) {
                break;
            }
        }

        return result;
    }

    get bleed(): boolean {
        return this.getBleed();
    }

    set bleed(value: boolean) {
        this.setBleed(value);
    }

    get padding(): PaddingDefinition | undefined {
        return this.getPadding();
    }

    set padding(value: PaddingDefinition | undefined) {
        this.setPadding(value);
    }

    get selectAction(): Action | undefined {
        return this._selectAction;
    }

    set selectAction(value: Action | undefined) {
        this._selectAction = value;
    }
}

function raiseImageLoadedEvent(image: Image) {
    let card = image.getRootElement() as AdaptiveCard;
    let onImageLoadedHandler = (card && card.onImageLoaded) ? card.onImageLoaded : AdaptiveCard.onImageLoaded;

    if (onImageLoadedHandler) {
        onImageLoadedHandler(image);
    }
}

function raiseAnchorClickedEvent(element: CardElement, anchor: HTMLAnchorElement): boolean {
    let card = element.getRootElement() as AdaptiveCard;
    let onAnchorClickedHandler = (card && card.onAnchorClicked) ? card.onAnchorClicked : AdaptiveCard.onAnchorClicked;

    return onAnchorClickedHandler !== undefined ? onAnchorClickedHandler(element, anchor) : false;
}

function raiseExecuteActionEvent(action: Action) {
    let card = action.parent ? action.parent.getRootElement() as AdaptiveCard : undefined;
    let onExecuteActionHandler = (card && card.onExecuteAction) ? card.onExecuteAction : AdaptiveCard.onExecuteAction;

    if (action.prepareForExecution() && onExecuteActionHandler) {
        onExecuteActionHandler(action);
    }
}

function raiseInlineCardExpandedEvent(action: ShowCardAction, isExpanded: boolean) {
    let card = action.parent ? action.parent.getRootElement() as AdaptiveCard : undefined;
    let onInlineCardExpandedHandler = (card && card.onInlineCardExpanded) ? card.onInlineCardExpanded : AdaptiveCard.onInlineCardExpanded;

    if (onInlineCardExpandedHandler) {
        onInlineCardExpandedHandler(action, isExpanded);
    }
}

function raiseInputValueChangedEvent(input: Input) {
    let card = input.getRootElement() as AdaptiveCard;
    let onInputValueChangedHandler = (card && card.onInputValueChanged) ? card.onInputValueChanged : AdaptiveCard.onInputValueChanged;

    if (onInputValueChangedHandler) {
        onInputValueChangedHandler(input);
    }
}

function raiseElementVisibilityChangedEvent(element: CardElement, shouldUpdateLayout: boolean = true) {
    let rootElement = element.getRootElement();

    if (shouldUpdateLayout) {
        rootElement.updateLayout();
    }

    let card = rootElement as AdaptiveCard;
    let onElementVisibilityChangedHandler = (card && card.onElementVisibilityChanged) ? card.onElementVisibilityChanged : AdaptiveCard.onElementVisibilityChanged;

    if (onElementVisibilityChangedHandler !== undefined) {
        onElementVisibilityChangedHandler(element);
    }
}

function raiseParseElementEvent(element: CardElement, json: any, errors?: IValidationError[]) {
    let card = element.getRootElement() as AdaptiveCard;
    let onParseElementHandler = (card && card.onParseElement) ? card.onParseElement : AdaptiveCard.onParseElement;

    if (onParseElementHandler !== undefined) {
        onParseElementHandler(element, json, errors);
    }
}

function raiseParseActionEvent(action: Action, json: any, errors?: IValidationError[]) {
    let card = action.parent ? action.parent.getRootElement() as AdaptiveCard : undefined;
    let onParseActionHandler = (card && card.onParseAction) ? card.onParseAction : AdaptiveCard.onParseAction;

    if (onParseActionHandler !== undefined) {
        onParseActionHandler(action, json, errors);
    }
}

function raiseParseError(error: IValidationError, errors: IValidationError[] | undefined) {
    if (errors) {
        errors.push(error);
    }

    if (AdaptiveCard.onParseError !== undefined) {
        AdaptiveCard.onParseError(error);
    }
}

export interface ITypeRegistration<T> {
    typeName: string,
    schemaVersion: TargetVersion,
    createInstance: () => T;
}

export abstract class ContainerWithActions extends Container {
    private _actionCollection: ActionCollection;

    protected internalRender(): HTMLElement | undefined {
        let element = super.internalRender();

        if (element) {
            let renderedActions = this._actionCollection.render(this.hostConfig.actions.actionsOrientation, false);

            if (renderedActions) {
                Utils.appendChild(
                    element,
                    Utils.renderSeparation(
                        this.hostConfig,
                        {
                            spacing: this.hostConfig.getEffectiveSpacing(this.hostConfig.actions.spacing)
                        },
                        Enums.Orientation.Horizontal));
                Utils.appendChild(element, renderedActions);
            }

            if (this.renderIfEmpty) {
                return element;
            }
            else {
                return element.children.length > 0 ? element : undefined;
            }
        }
        else {
            return undefined;
        }
    }

    protected getHasExpandedAction(): boolean {
        if (this.renderedActionCount == 0) {
            return false;
        }
        else if (this.renderedActionCount == 1) {
            return this._actionCollection.expandedAction !== undefined && !this.hostConfig.actions.preExpandSingleShowCardAction;
        }
        else {
            return this._actionCollection.expandedAction !== undefined;
        }
    }

    protected get renderedActionCount(): number {
        return this._actionCollection.renderedActionCount;
    }

    protected get renderIfEmpty(): boolean {
        return false;
    }

    constructor() {
        super();

        this._actionCollection = new ActionCollection(this);
    }

    parse(json: any, errors?: IValidationError[]) {
        super.parse(json, errors);

        this._actionCollection.parse(json["actions"], errors);
    }

    toJSON(): any {
        let result = super.toJSON();

        Utils.setProperty(result, "actions", this._actionCollection.toJSON());

        return result;
    }

    getActionCount(): number {
        return this._actionCollection.items.length;
    }

    getActionAt(index: number): Action | undefined {
        if (index >= 0 && index < this.getActionCount()) {
            return this._actionCollection.items[index];
        }
        else {
            return super.getActionAt(index);
        }
    }

    getActionById(id: string): Action | undefined {
        let result: Action | undefined = this._actionCollection.getActionById(id);

        return result ? result : super.getActionById(id);
    }

    internalValidateProperties(context: ValidationResults) {
        super.internalValidateProperties(context);

        if (this._actionCollection) {
            this._actionCollection.validateProperties(context);
        }
    }

    isLastElement(element: CardElement): boolean {
        return super.isLastElement(element) && this._actionCollection.items.length == 0;
    }

    addAction(action: Action) {
        this._actionCollection.addAction(action);
    }

    clear() {
        super.clear();

        this._actionCollection.clear();
    }

    getAllInputs(): Input[] {
        return super.getAllInputs().concat(this._actionCollection.getAllInputs());
    }

    getResourceInformation(): IResourceInformation[] {
        return super.getResourceInformation().concat(this._actionCollection.getResourceInformation());
    }

    isBleedingAtBottom(): boolean {
        if (this._actionCollection.renderedActionCount == 0) {
            return super.isBleedingAtBottom();
        }
        else {
            if (this._actionCollection.items.length == 1) {
                return this._actionCollection.expandedAction !== undefined && !this.hostConfig.actions.preExpandSingleShowCardAction;
            }
            else {
                return this._actionCollection.expandedAction !== undefined;
            }
        }
    }

    get isStandalone(): boolean {
        return false;
    }
}

export abstract class TypeRegistry<T> {
    private _items: ITypeRegistration<T>[] = [];

    private findTypeRegistration(typeName: string): ITypeRegistration<T> | undefined {
        for (let item of this._items) {
            if (item.typeName === typeName) {
                return item;
            }
        }

        return undefined;
    }

    constructor() {
        this.reset();
    }

    clear() {
        this._items = [];
    }

    abstract reset(): void;

    registerType(typeName: string, createInstance: () => T, schemaVersion: TargetVersion = "*") {
        let registrationInfo = this.findTypeRegistration(typeName);

        if (registrationInfo !== undefined) {
            registrationInfo.createInstance = createInstance;
        }
        else {
            registrationInfo = {
                typeName: typeName,
                schemaVersion: schemaVersion,
                createInstance: createInstance
            }

            this._items.push(registrationInfo);
        }
    }

    unregisterType(typeName: string) {
        for (let i = 0; i < this._items.length; i++) {
            if (this._items[i].typeName === typeName) {
                this._items.splice(i, 1);

                return;
            }
        }
    }

    createInstance(typeName: string): T | undefined {
        let registrationInfo = this.findTypeRegistration(typeName);

        return registrationInfo ? registrationInfo.createInstance() : undefined;
    }

    getItemCount(): number {
        return this._items.length;
    }

    getItemAt(index: number): ITypeRegistration<T> {
        return this._items[index];
    }
}

export class ElementTypeRegistry extends TypeRegistry<CardElement> {
    reset(): void {
        this.clear();

        this.registerType("Container", () => { return new Container(); });
        this.registerType("TextBlock", () => { return new TextBlock(); });
        this.registerType("RichTextBlock", () => { return new RichTextBlock(); }, Versions.v1_2);
        this.registerType("TextRun", () => { return new TextRun(); }, Versions.v1_2);
        this.registerType("Image", () => { return new Image(); });
        this.registerType("ImageSet", () => { return new ImageSet(); });
        this.registerType("Media", () => { return new Media(); }, Versions.v1_1);
        this.registerType("FactSet", () => { return new FactSet(); });
        this.registerType("ColumnSet", () => { return new ColumnSet(); });
        this.registerType("ActionSet", () => { return new ActionSet(); }, Versions.v1_2);
        this.registerType("Input.Text", () => { return new TextInput(); });
        this.registerType("Input.Date", () => { return new DateInput(); });
        this.registerType("Input.Time", () => { return new TimeInput(); });
        this.registerType("Input.Number", () => { return new NumberInput(); });
        this.registerType("Input.ChoiceSet", () => { return new ChoiceSetInput(); });
        this.registerType("Input.Toggle", () => { return new ToggleInput(); });
    }
}

export class ActionTypeRegistry extends TypeRegistry<Action> {
    reset(): void {
        this.clear();

        this.registerType(OpenUrlAction.JsonTypeName, () => { return new OpenUrlAction(); });
        this.registerType(SubmitAction.JsonTypeName, () => { return new SubmitAction(); });
        this.registerType(ShowCardAction.JsonTypeName, () => { return new ShowCardAction(); });
        this.registerType(ToggleVisibilityAction.JsonTypeName, () => { return new ToggleVisibilityAction(); }, Versions.v1_2);
    }
}

export interface IMarkdownProcessingResult {
    didProcess: boolean;
    outputHtml?: any;
}

export class AdaptiveCard extends ContainerWithActions {
    static readonly schemaUrl = "http://adaptivecards.io/schemas/adaptive-card.json";

    //#region Schema

    protected static readonly $schemaProperty = new CustomProperty<string>(
        Versions.v1_0,
        "$schema",
        (sender: SerializableObject, property: PropertyDefinition, source: PropertyBag, errors?: IValidationError[]) => {
            return AdaptiveCard.schemaUrl;
        },
        (sender: SerializableObject, property: PropertyDefinition, target: PropertyBag, value: Versions | undefined) => {
            Utils.setProperty(target, property.name, AdaptiveCard.schemaUrl);
        });

    static readonly versionProperty = new CustomProperty<Version | undefined>(
        Versions.v1_0,
        "version",
        (sender: SerializableObject, property: PropertyDefinition, source: PropertyBag, errors?: IValidationError[]) => {
            return Version.parse(source[property.name], errors);
        },
        (sender: SerializableObject, property: PropertyDefinition, target: PropertyBag, value: Versions | undefined) => {
            if (value !== undefined) {
                Utils.setProperty(target, property.name, value.toString());
            }
        },
        Versions.v1_0);
    static readonly fallbackTextProperty = new StringProperty(Versions.v1_0, "fallbackText");
    static readonly speakProperty = new StringProperty(Versions.v1_0, "speak");

    @property(AdaptiveCard.versionProperty)
    version: Version;

    @property(AdaptiveCard.fallbackTextProperty)
    fallbackText?: string;

    @property(AdaptiveCard.speakProperty)
    speak?: string;

    //#endregion

    static readonly elementTypeRegistry = new ElementTypeRegistry();
    static readonly actionTypeRegistry = new ActionTypeRegistry();

    static onAnchorClicked?: (element: CardElement, anchor: HTMLAnchorElement) => boolean;
    static onExecuteAction?: (action: Action) => void;
    static onElementVisibilityChanged?: (element: CardElement) => void;
    static onImageLoaded?: (image: Image) => void;
    static onInlineCardExpanded?: (action: ShowCardAction, isExpanded: boolean) => void;
    static onInputValueChanged?: (input: Input) => void;
    static onParseElement?: (element: CardElement, json: any, errors?: IValidationError[]) => void;
    static onParseAction?: (element: Action, json: any, errors?: IValidationError[]) => void;
    static onParseError?: (error: IValidationError) => void;
    static onProcessMarkdown?: (text: string, result: IMarkdownProcessingResult) => void;

    static get processMarkdown(): (text: string) => string {
        throw new Error("The processMarkdown event has been removed. Please update your code and set onProcessMarkdown instead.")
    }

    static set processMarkdown(value: (text: string) => string) {
        throw new Error("The processMarkdown event has been removed. Please update your code and set onProcessMarkdown instead.")
    }

    static applyMarkdown(text: string): IMarkdownProcessingResult {
        let result: IMarkdownProcessingResult = {
            didProcess: false
        };

        if (AdaptiveCard.onProcessMarkdown) {
            AdaptiveCard.onProcessMarkdown(text, result);
        }
        else if ((<any>window).markdownit) {
            // Check for markdownit
            let markdownIt: any = (<any>window).markdownit;
            result.outputHtml = markdownIt().render(text);
            result.didProcess = true;
        }
        else {
            console.warn("Markdown processing isn't enabled. Please see https://www.npmjs.com/package/adaptivecards#supporting-markdown")
        }

        return result;
    }

    private _fallbackCard?: AdaptiveCard;

    private isVersionSupported(): boolean {
        if (this.bypassVersionCheck) {
            return true;
        }
        else {
            let unsupportedVersion: boolean =
                !this.version ||
                !this.version.isValid ||
                (Versions.latest.major < this.version.major) ||
                (Versions.latest.major == this.version.major && Versions.latest.minor < this.version.minor);

            return !unsupportedVersion;
        }
    }

    protected getItemsCollectionPropertyName(): string {
        return "body";
    }

    protected internalRender(): HTMLElement | undefined {
        let renderedElement = super.internalRender();

        if (GlobalSettings.useAdvancedCardBottomTruncation && renderedElement) {
            // Unlike containers, the root card element should be allowed to
            // be shorter than its content (otherwise the overflow truncation
            // logic would never get triggered)
            renderedElement.style.removeProperty("minHeight");
        }

        return renderedElement;
    }

    protected getHasBackground(): boolean {
        return true;
    }

    protected getDefaultPadding(): PaddingDefinition {
        return new PaddingDefinition(
            Enums.Spacing.Padding,
            Enums.Spacing.Padding,
            Enums.Spacing.Padding,
            Enums.Spacing.Padding);
    }

    protected get renderIfEmpty(): boolean {
        return true;
    }

    protected get bypassVersionCheck(): boolean {
        return false;
    }

    protected get allowCustomStyle() {
        return this.hostConfig.adaptiveCard && this.hostConfig.adaptiveCard.allowCustomStyle;
    }

    protected get hasBackground(): boolean {
        return true;
    }

    onAnchorClicked?: (element: CardElement, anchor: HTMLAnchorElement) => boolean;
    onExecuteAction?: (action: Action) => void;
    onElementVisibilityChanged?: (element: CardElement) => void;
    onImageLoaded?: (image: Image) => void;
    onInlineCardExpanded?: (action: ShowCardAction, isExpanded: boolean) => void;
    onInputValueChanged?: (input: Input) => void;
    onParseElement?: (element: CardElement, json: any, errors?: IValidationError[]) => void;
    onParseAction?: (element: Action, json: any, errors?: IValidationError[]) => void;

    designMode: boolean = false;

    getJsonTypeName(): string {
        return "AdaptiveCard";
    }

    parse(json: any, errors?: IValidationError[]) {
        this._fallbackCard = undefined;

        let fallbackElement = createElementInstance(
            undefined,
            json["fallback"],
            !this.isDesignMode(),
            errors);

        if (fallbackElement) {
            this._fallbackCard = new AdaptiveCard();
            this._fallbackCard.addItem(fallbackElement);
        }

        super.parse(json, errors);
    }

    internalValidateProperties(context: ValidationResults) {
        super.internalValidateProperties(context);

        if (this.getValue(CardElement.typeNameProperty) !== "AdaptiveCard") {
            context.addFailure(
                this,
                {
                    error: Enums.ValidationError.MissingCardType,
                    message: "Invalid or missing card type. Make sure the card's type property is set to \"AdaptiveCard\"."
                });
        }

        if (!this.bypassVersionCheck && !this.version) {
            context.addFailure(
                this,
                {
                    error: Enums.ValidationError.PropertyCantBeNull,
                    message: "The version property must be specified."
                });
        }
        else if (!this.isVersionSupported()) {
            context.addFailure(
                this,
                {
                    error: Enums.ValidationError.UnsupportedCardVersion,
                    message: "The specified card version (" + this.version + ") is not supported. The maximum supported card version is " + Versions.latest
                });
        }
    }

    render(target?: HTMLElement): HTMLElement | undefined {
        let renderedCard: HTMLElement | undefined;

        if (this.shouldFallback() && this._fallbackCard) {
            this._fallbackCard.hostConfig = this.hostConfig;

            renderedCard = this._fallbackCard.render();
        }
        else {
            renderedCard = super.render();

            if (renderedCard) {
                renderedCard.classList.add(this.hostConfig.makeCssClassName("ac-adaptiveCard"));
                renderedCard.tabIndex = 0;

                if (!Utils.isNullOrEmpty(this.speak)) {
                    renderedCard.setAttribute("aria-label", <string>this.speak);
                }
            }
        }

        if (target) {
            Utils.appendChild(target, renderedCard);

            this.updateLayout();
        }

        return renderedCard;
    }

    updateLayout(processChildren: boolean = true) {
        super.updateLayout(processChildren);

        if (GlobalSettings.useAdvancedCardBottomTruncation && this.isDisplayed()) {
            let padding = this.hostConfig.getEffectiveSpacing(Enums.Spacing.Default);

            this['handleOverflow']((<HTMLElement>this.renderedElement).offsetHeight - padding);
        }
    }

    shouldFallback(): boolean {
        return super.shouldFallback() || !this.isVersionSupported();
    }

    get hasVisibleSeparator(): boolean {
        return false;
    }
}

class InlineAdaptiveCard extends AdaptiveCard {
    //#region Schema

    protected getSchemaKey(): string {
        return "InlineAdaptiveCard";
    }

    protected populateSchema(schema: SerializableObjectSchema) {
        super.populateSchema(schema);

        schema.remove(
            AdaptiveCard.$schemaProperty,
            AdaptiveCard.versionProperty);
    }

    //#endregion

    protected getDefaultPadding(): PaddingDefinition {
        return new PaddingDefinition(
            this.suppressStyle ? Enums.Spacing.None : Enums.Spacing.Padding,
            Enums.Spacing.Padding,
            this.suppressStyle ? Enums.Spacing.None : Enums.Spacing.Padding,
            Enums.Spacing.Padding);
    }

    protected get bypassVersionCheck(): boolean {
        return true;
    }

    protected get defaultStyle(): string {
        if (this.suppressStyle) {
            return Enums.ContainerStyle.Default;
        }
        else {
            return this.hostConfig.actions.showCard.style ? this.hostConfig.actions.showCard.style : Enums.ContainerStyle.Emphasis;
        }
    }

    suppressStyle: boolean = false;

    render(target?: HTMLElement): HTMLElement | undefined {
        let renderedCard = super.render(target);

        if (renderedCard) {
            renderedCard.setAttribute("aria-live", "polite");
            renderedCard.removeAttribute("tabindex");
        }

        return renderedCard;
    }

    getForbiddenActionTypes(): any[] {
        return [ShowCardAction];
    }
}

const defaultHostConfig: HostConfig.HostConfig = new HostConfig.HostConfig(
    {
        supportsInteractivity: true,
        spacing: {
            small: 10,
            default: 20,
            medium: 30,
            large: 40,
            extraLarge: 50,
            padding: 20
        },
        separator: {
            lineThickness: 1,
            lineColor: "#EEEEEE"
        },
        fontTypes: {
            default: {
                fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
                fontSizes: {
                    small: 12,
                    default: 14,
                    medium: 17,
                    large: 21,
                    extraLarge: 26
                },
                fontWeights: {
                    lighter: 200,
                    default: 400,
                    bolder: 600
                }
            },
            monospace: {
                fontFamily: "'Courier New', Courier, monospace",
                fontSizes: {
                    small: 12,
                    default: 14,
                    medium: 17,
                    large: 21,
                    extraLarge: 26
                },
                fontWeights: {
                    lighter: 200,
                    default: 400,
                    bolder: 600
                }
            }
        },
        imageSizes: {
            small: 40,
            medium: 80,
            large: 160
        },
        containerStyles: {
            default: {
                backgroundColor: "#FFFFFF",
                foregroundColors: {
                    default: {
                        default: "#333333",
                        subtle: "#EE333333"
                    },
                    dark: {
                        default: "#000000",
                        subtle: "#66000000"
                    },
                    light: {
                        default: "#FFFFFF",
                        subtle: "#33000000"
                    },
                    accent: {
                        default: "#2E89FC",
                        subtle: "#882E89FC"
                    },
                    attention: {
                        default: "#cc3300",
                        subtle: "#DDcc3300"
                    },
                    good: {
                        default: "#54a254",
                        subtle: "#DD54a254"
                    },
                    warning: {
                        default: "#e69500",
                        subtle: "#DDe69500"
                    }
                }
            },
            emphasis: {
                backgroundColor: "#08000000",
                foregroundColors: {
                    default: {
                        default: "#333333",
                        subtle: "#EE333333"
                    },
                    dark: {
                        default: "#000000",
                        subtle: "#66000000"
                    },
                    light: {
                        default: "#FFFFFF",
                        subtle: "#33000000"
                    },
                    accent: {
                        default: "#2E89FC",
                        subtle: "#882E89FC"
                    },
                    attention: {
                        default: "#cc3300",
                        subtle: "#DDcc3300"
                    },
                    good: {
                        default: "#54a254",
                        subtle: "#DD54a254"
                    },
                    warning: {
                        default: "#e69500",
                        subtle: "#DDe69500"
                    }
                }
            },
            accent: {
                backgroundColor: "#C7DEF9",
                foregroundColors: {
                    default: {
                        default: "#333333",
                        subtle: "#EE333333"
                    },
                    dark: {
                        default: "#000000",
                        subtle: "#66000000"
                    },
                    light: {
                        default: "#FFFFFF",
                        subtle: "#33000000"
                    },
                    accent: {
                        default: "#2E89FC",
                        subtle: "#882E89FC"
                    },
                    attention: {
                        default: "#cc3300",
                        subtle: "#DDcc3300"
                    },
                    good: {
                        default: "#54a254",
                        subtle: "#DD54a254"
                    },
                    warning: {
                        default: "#e69500",
                        subtle: "#DDe69500"
                    }
                }
            },
            good: {
                backgroundColor: "#CCFFCC",
                foregroundColors: {
                    default: {
                        default: "#333333",
                        subtle: "#EE333333"
                    },
                    dark: {
                        default: "#000000",
                        subtle: "#66000000"
                    },
                    light: {
                        default: "#FFFFFF",
                        subtle: "#33000000"
                    },
                    accent: {
                        default: "#2E89FC",
                        subtle: "#882E89FC"
                    },
                    attention: {
                        default: "#cc3300",
                        subtle: "#DDcc3300"
                    },
                    good: {
                        default: "#54a254",
                        subtle: "#DD54a254"
                    },
                    warning: {
                        default: "#e69500",
                        subtle: "#DDe69500"
                    }
                }
            },
            attention: {
                backgroundColor: "#FFC5B2",
                foregroundColors: {
                    default: {
                        default: "#333333",
                        subtle: "#EE333333"
                    },
                    dark: {
                        default: "#000000",
                        subtle: "#66000000"
                    },
                    light: {
                        default: "#FFFFFF",
                        subtle: "#33000000"
                    },
                    accent: {
                        default: "#2E89FC",
                        subtle: "#882E89FC"
                    },
                    attention: {
                        default: "#cc3300",
                        subtle: "#DDcc3300"
                    },
                    good: {
                        default: "#54a254",
                        subtle: "#DD54a254"
                    },
                    warning: {
                        default: "#e69500",
                        subtle: "#DDe69500"
                    }
                }
            },
            warning: {
                backgroundColor: "#FFE2B2",
                foregroundColors: {
                    default: {
                        default: "#333333",
                        subtle: "#EE333333"
                    },
                    dark: {
                        default: "#000000",
                        subtle: "#66000000"
                    },
                    light: {
                        default: "#FFFFFF",
                        subtle: "#33000000"
                    },
                    accent: {
                        default: "#2E89FC",
                        subtle: "#882E89FC"
                    },
                    attention: {
                        default: "#cc3300",
                        subtle: "#DDcc3300"
                    },
                    good: {
                        default: "#54a254",
                        subtle: "#DD54a254"
                    },
                    warning: {
                        default: "#e69500",
                        subtle: "#DDe69500"
                    }
                }
            }
        },
        actions: {
            maxActions: 5,
            spacing: Enums.Spacing.Default,
            buttonSpacing: 10,
            showCard: {
                actionMode: Enums.ShowCardActionMode.Inline,
                inlineTopMargin: 16
            },
            actionsOrientation: Enums.Orientation.Horizontal,
            actionAlignment: Enums.ActionAlignment.Left
        },
        adaptiveCard: {
            allowCustomStyle: false
        },
        imageSet: {
            imageSize: Enums.Size.Medium,
            maxImageHeight: 100
        },
        factSet: {
            title: {
                color: Enums.TextColor.Default,
                size: Enums.TextSize.Default,
                isSubtle: false,
                weight: Enums.TextWeight.Bolder,
                wrap: true,
                maxWidth: 150,
            },
            value: {
                color: Enums.TextColor.Default,
                size: Enums.TextSize.Default,
                isSubtle: false,
                weight: Enums.TextWeight.Default,
                wrap: true,
            },
            spacing: 10
        }
    });