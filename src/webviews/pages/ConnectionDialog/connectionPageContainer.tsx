/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import "./sqlServerRotation.css";

import {
    ConnectionDialogContextProps,
    ConnectionDialogFormItemSpec,
    ConnectionDialogWebviewState,
    ConnectionStringDialogProps,
    IConnectionDialogProfile,
    ChangePasswordDialogProps,
    TrustServerCertDialogProps,
} from "../../../sharedInterfaces/connectionDialog";
import {
    CREATE_NEW_GROUP_ID,
    CreateConnectionGroupDialogProps,
} from "../../../sharedInterfaces/connectionGroup";
import { Link, makeStyles } from "@fluentui/react-components";
import { Form20Regular } from "@fluentui/react-icons";
import { FormField, useFormStyles } from "../../common/forms/form.component";
import { useContext } from "react";

import { ConnectionDialogContext } from "./connectionDialogStateProvider";
import { useConnectionDialogSelector } from "./connectionDialogSelector";
import { ConnectionFormPage } from "./connectionFormPage";
import { TrustServerCertificateDialog } from "./components/trustServerCertificateDialog.component";
import { ConnectionStringDialog } from "./components/connectionStringDialog.component";
import { locConstants } from "../../common/locConstants";
import { ConnectionGroupDialog } from "../ConnectionGroup/connectionGroup.component";
import {
    renderColorSwatch,
    SearchableDropdownOptions,
} from "../../common/searchableDropdown.component";
import { ChangePasswordDialog } from "../ChangePassword/changePasswordDialog";
import { DialogMessage } from "../../common/dialogMessage";

const useStyles = makeStyles({
    inputLink: {
        display: "flex",
        alignItems: "center",
    },
    formContent: {
        width: "100%",
        boxSizing: "border-box",
        padding: "0 16px",
    },
});

export const ConnectionInfoFormContainer = () => {
    const context = useContext(ConnectionDialogContext)!;
    const dialog = useConnectionDialogSelector((s) => s.dialog);
    const formMessage = useConnectionDialogSelector((s) => s.formMessage);
    const formState = useConnectionDialogSelector((s) => s.formState);
    const formComponents = useConnectionDialogSelector((s) => s.formComponents);
    const formStyles = useFormStyles();
    const styles = useStyles();

    const changePasswordDialogState =
        dialog?.type === "changePassword" ? (dialog as ChangePasswordDialogProps).props : undefined;

    function handleConnect(event: React.FormEvent) {
        event.preventDefault();
        context.connect();
    }

    return (
        <form id="connectionForm" onSubmit={handleConnect}>
            <button type="submit" style={{ display: "none" }} aria-hidden="true" tabIndex={-1} />
            <div className={styles.formContent}>
                {formMessage && (
                    <DialogMessage
                        message={formMessage}
                        onMessageButtonClicked={context.messageButtonClicked}
                        onCloseMessage={context.closeMessage}
                    />
                )}

                {dialog?.type === "trustServerCert" && (
                    <TrustServerCertificateDialog
                        dialogProps={dialog as TrustServerCertDialogProps}
                    />
                )}
                {dialog?.type === "changePassword" && (
                    <ChangePasswordDialog
                        mode="modal"
                        serverName={changePasswordDialogState?.server}
                        userName={changePasswordDialogState?.userName}
                        onSubmit={context.changePassword}
                        onClose={context.closeDialog}
                    />
                )}
                {dialog?.type === "loadFromConnectionString" && (
                    <ConnectionStringDialog dialogProps={dialog as ConnectionStringDialogProps} />
                )}
                {dialog?.type === "createConnectionGroup" && (
                    <ConnectionGroupDialog
                        mode="modal"
                        state={(dialog as CreateConnectionGroupDialogProps).props}
                        saveConnectionGroup={context.createConnectionGroup}
                        closeDialog={context.closeDialog}
                    />
                )}

                <FormField<
                    IConnectionDialogProfile,
                    ConnectionDialogWebviewState,
                    ConnectionDialogFormItemSpec,
                    ConnectionDialogContextProps
                >
                    context={context}
                    formState={formState}
                    component={formComponents["profileName"] as ConnectionDialogFormItemSpec}
                    idx={0}
                    props={{ orientation: "horizontal" }}
                />

                <FormField<
                    IConnectionDialogProfile,
                    ConnectionDialogWebviewState,
                    ConnectionDialogFormItemSpec,
                    ConnectionDialogContextProps
                >
                    context={context}
                    formState={formState}
                    component={formComponents["groupId"] as ConnectionDialogFormItemSpec}
                    idx={0}
                    props={{ orientation: "horizontal" }}
                    componentProps={{
                        onSelect: (option: SearchableDropdownOptions) => {
                            if (option.value === CREATE_NEW_GROUP_ID) {
                                context.openCreateConnectionGroupDialog();
                            } else {
                                context.formAction({
                                    propertyName: "groupId",
                                    isAction: false,
                                    value: option.value,
                                });
                            }
                        },
                        renderDecoration: (option: SearchableDropdownOptions) => {
                            return renderColorSwatch(option.color);
                        },
                    }}
                />

                <FormField<
                    IConnectionDialogProfile,
                    ConnectionDialogWebviewState,
                    ConnectionDialogFormItemSpec,
                    ConnectionDialogContextProps
                >
                    context={context}
                    formState={formState}
                    component={formComponents["databaseFilter"] as ConnectionDialogFormItemSpec}
                    idx={0}
                    props={{ orientation: "horizontal" }}
                />

                <div className={formStyles.formComponentDiv}>
                    <div className={styles.inputLink}>
                        <Form20Regular style={{ marginRight: "8px" }} />
                        <Link
                            onClick={() => {
                                context.openConnectionStringDialog();
                            }}
                            inline>
                            {locConstants.connectionDialog.loadFromConnectionString}
                        </Link>
                    </div>
                </div>
                <ConnectionFormPage />
            </div>
        </form>
    );
};
