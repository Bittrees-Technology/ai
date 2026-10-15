import React, { useId } from 'react';
import './login.css';

const icons={AutoNote:'/icon.svg',News:'/brand/tbn-mark.svg'};
/** Shared presentation only; authentication and security stay with each app. */
export function LoginPanel({ product, icon, title = 'Sign in', description = 'Use your email address or Ethereum wallet.', email, wallet, notice, footer, children }) {
  const heading = useId();
  return <div className="bt-login-stack"><section className="bt-login-panel" aria-labelledby={heading}>
    <div className="bt-login-brand"><img className="bt-login-icon" src={icon||icons[product]||'/favicon.svg'} width="28" height="28" alt="" aria-hidden="true"/><span>bittrees <strong>{product}</strong></span></div>
    <h2 id={heading} className="bt-login-title">{title}</h2>
    <p className="bt-login-description">{description}</p>
    {children}
    {email && <div className="bt-login-email">{email}</div>}
    {email && wallet && <div className="bt-login-divider"><span>or</span></div>}
    {wallet && <div className="bt-login-wallet">{wallet}</div>}
    {notice && <div className="bt-login-notice">{notice}</div>}
    <div className="bt-login-footer"><p>Wallet sign-in verifies ownership. It does not authorize a transaction.</p></div>
  </section>{footer&&<div className="bt-login-context">{footer}</div>}</div>;
}

export function EmailSignIn({email,onEmailChange,challenge,code,onCodeChange,onSubmit,onReset,busy=false,disabled=false,codeLength=8}) {
  return <form className="bt-login-email-form" onSubmit={onSubmit}>
    <label className="bt-login-email-label">Email address<input name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="you@example.org" required maxLength={254} value={email} readOnly={Boolean(challenge)} disabled={busy||disabled} onChange={e=>onEmailChange(e.target.value)}/></label>
    {challenge&&<label className="bt-login-code-label">Verification code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern={'[0-9]{'+codeLength+'}'} maxLength={codeLength} required value={code} disabled={busy} onChange={onCodeChange?e=>onCodeChange(e.target.value.replace(/\D/g,'')):undefined}/></label>}
    <button className="bt-login-email-submit" type="submit" disabled={busy||disabled}>{busy?'Please wait…':challenge?'Verify and continue':'Send verification code'}</button>
    {challenge&&<button type="button" className="text-button" disabled={busy} onClick={onReset}>Change email or request a new code</button>}
  </form>;
}
export function EthereumSignIn({onClick,busy=false,disabled=false,label='Sign in with Ethereum'}) {
  return <button className="bt-login-ethereum-submit" type="button" disabled={busy||disabled} onClick={onClick}>{busy?'Please wait…':label}</button>;
}
