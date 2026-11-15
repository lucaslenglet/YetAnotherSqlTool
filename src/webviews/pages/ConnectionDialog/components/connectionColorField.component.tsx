// "Color" field of the connection dialog: the color shown in the status bar and along the SQL
// editors that use the connection. Swatches for "no color" and the palette of the connection
// groups, plus any other color through the color picker of the connection group dialog.

import {
    Button,
    Field,
    makeStyles,
    mergeClasses,
    Popover,
    PopoverSurface,
    PopoverTrigger,
    tokens,
    useId,
} from "@fluentui/react-components";
import {
    ColorArea,
    ColorPicker,
    ColorPickerProps,
    ColorSlider,
} from "@fluentui/react-color-picker";
import { Checkmark12Filled, Color16Regular } from "@fluentui/react-icons";
import { TinyColor } from "@ctrl/tinycolor";
import { useState } from "react";
import { useFormStyles } from "../../../common/forms/form.component";
import { locConstants } from "../../../common/locConstants";
import { colors as paletteColors } from "../../ConnectionGroup/connectionGroup.component";

const useStyles = makeStyles({
    swatches: {
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "6px",
        minHeight: "32px",
    },
    swatch: {
        position: "relative",
        width: "22px",
        height: "22px",
        padding: 0,
        borderRadius: "4px",
        border: `1px solid ${tokens.colorNeutralStroke1}`,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#ffffff",
        "@media (forced-colors: active)": {
            forcedColorAdjust: "none",
        },
        ":focus-visible": {
            outline: `2px solid ${tokens.colorStrokeFocus2}`,
            outlineOffset: "2px",
        },
    },
    selected: {
        outline: `2px solid ${tokens.colorNeutralForeground1}`,
        outlineOffset: "2px",
    },
    // A red diagonal over the background, the usual sign for "none".
    noColor: {
        backgroundColor: tokens.colorNeutralBackground1,
        backgroundImage: `linear-gradient(to top right, transparent calc(50% - 1px), ${tokens.colorPaletteRedForeground1} calc(50% - 1px), ${tokens.colorPaletteRedForeground1} calc(50% + 1px), transparent calc(50% + 1px))`,
    },
    custom: {
        color: tokens.colorNeutralForeground1,
        backgroundColor: tokens.colorNeutralBackground1,
    },
    row: {
        display: "flex",
        gap: "10px",
        marginTop: "10px",
    },
    preview: {
        width: "80px",
        borderRadius: "4px",
        border: "1px solid #ccc",
        alignSelf: "stretch",
        "@media (forced-colors: active)": {
            forcedColorAdjust: "none",
        },
    },
});

/** Same rule as the extension (connectionColor.ts): anything else is no color. */
const colorPattern = /^#[0-9a-f]{6}$/i;

function sameColor(a: string | undefined, b: string | undefined): boolean {
    return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export const ConnectionColorField = ({
    value,
    onChange,
}: {
    /** The profile's color (`#RRGGBB`); empty or undefined for none. */
    value: string | undefined;
    /** Called with the chosen color, or "" for none. */
    onChange: (color: string) => void;
}) => {
    const formStyles = useFormStyles();
    const styles = useStyles();
    const labelId = useId("connectionColorLabel");
    const color = value && colorPattern.test(value) ? value : undefined;
    const isCustom = !!color && !paletteColors.some((c) => sameColor(c, color));

    const [popoverOpen, setPopoverOpen] = useState(false);
    const [pickerColor, setPickerColor] = useState(
        new TinyColor(color ?? paletteColors[0]).toHsv(),
    );

    const handlePickerChange: ColorPickerProps["onColorChange"] = (_, data) => {
        setPickerColor({ ...data.color, a: 1 });
    };

    const swatch = (swatchColor: string) => {
        const selected = sameColor(swatchColor, color);
        return (
            <button
                key={swatchColor}
                type="button"
                className={mergeClasses(styles.swatch, selected && styles.selected)}
                style={{ backgroundColor: swatchColor }}
                aria-label={locConstants.connectionDialog.colorSwatch(swatchColor)}
                aria-pressed={selected}
                title={swatchColor}
                data-color={swatchColor}
                onClick={() => onChange(swatchColor)}>
                {selected && <Checkmark12Filled />}
            </button>
        );
    };

    return (
        <div className={formStyles.formComponentDiv}>
            <Field
                orientation="horizontal"
                label={{ children: locConstants.connectionDialog.color, id: labelId }}
                style={{ color: tokens.colorNeutralForeground1 }}>
                <div className={styles.swatches} role="group" aria-labelledby={labelId}>
                    <button
                        type="button"
                        className={mergeClasses(
                            styles.swatch,
                            styles.noColor,
                            !color && styles.selected,
                        )}
                        aria-label={locConstants.connectionDialog.noColor}
                        aria-pressed={!color}
                        title={locConstants.connectionDialog.noColor}
                        data-color=""
                        onClick={() => onChange("")}
                    />
                    {paletteColors.map(swatch)}
                    <Popover
                        open={popoverOpen}
                        trapFocus
                        onOpenChange={(_, data) => {
                            if (data.open) {
                                setPickerColor(new TinyColor(color ?? paletteColors[0]).toHsv());
                            }
                            setPopoverOpen(data.open);
                        }}>
                        <PopoverTrigger disableButtonEnhancement>
                            <button
                                type="button"
                                className={mergeClasses(
                                    styles.swatch,
                                    !isCustom && styles.custom,
                                    isCustom && styles.selected,
                                )}
                                style={isCustom ? { backgroundColor: color } : undefined}
                                aria-label={
                                    isCustom
                                        ? `${locConstants.connectionDialog.customColor} ${color}`
                                        : locConstants.connectionDialog.customColor
                                }
                                aria-pressed={isCustom}
                                title={locConstants.connectionDialog.customColor}
                                data-color="custom">
                                {isCustom ? <Checkmark12Filled /> : <Color16Regular />}
                            </button>
                        </PopoverTrigger>
                        <PopoverSurface>
                            <ColorPicker color={pickerColor} onColorChange={handlePickerChange}>
                                <ColorArea
                                    inputX={{
                                        "aria-label": locConstants.connectionGroups.saturation,
                                    }}
                                    inputY={{
                                        "aria-label": locConstants.connectionGroups.brightness,
                                    }}
                                />
                                <div className={styles.row}>
                                    <ColorSlider aria-label={locConstants.connectionGroups.hue} />
                                    <div
                                        className={styles.preview}
                                        style={{
                                            backgroundColor: new TinyColor(
                                                pickerColor,
                                            ).toRgbString(),
                                        }}
                                    />
                                </div>
                            </ColorPicker>
                            <div className={styles.row}>
                                <Button
                                    appearance="primary"
                                    onClick={() => {
                                        onChange(
                                            new TinyColor(pickerColor)
                                                .toHexString(false /* allow3Char */)
                                                .toLowerCase(),
                                        );
                                        setPopoverOpen(false);
                                    }}>
                                    {locConstants.common.select}
                                </Button>
                                <Button onClick={() => setPopoverOpen(false)}>
                                    {locConstants.common.cancel}
                                </Button>
                            </div>
                        </PopoverSurface>
                    </Popover>
                </div>
            </Field>
        </div>
    );
};
