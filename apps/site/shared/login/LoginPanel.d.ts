import type { ReactNode, ReactElement, FormEventHandler } from 'react';
export type LoginPanelProps = {product:string;icon?:string;title?:string;description?:ReactNode;email?:ReactNode;wallet?:ReactNode;notice?:ReactNode;footer?:ReactNode;children?:ReactNode;};
export function LoginPanel(props:LoginPanelProps):ReactElement;
export type EmailSignInProps={email:string;onEmailChange:(value:string)=>void;challenge?:unknown;code?:string;onCodeChange?:(value:string)=>void;onSubmit:FormEventHandler<HTMLFormElement>;onReset:()=>void;busy?:boolean;disabled?:boolean;codeLength?:number;};
export function EmailSignIn(props:EmailSignInProps):ReactElement;
export function EthereumSignIn(props:{onClick:()=>void;busy?:boolean;disabled?:boolean;label?:string}):ReactElement;
