(() => {
    const base=location.pathname.split('/pages/')[0];
    fetch(base+'/api/auth/me.php').then(r=>r.json()).then(r=>{
        if(!r.success)return;
        const a=document.getElementById('recoveryEmailLink'),b=document.querySelector('[data-student-recovery]');
        if(a)a.hidden=r.data.account_type==='learner'||Number(r.data.role_id)===10;
        if(b){const canReview=[7,9,11].includes(Number(r.data.role_id));b.hidden=!canReview;b.setAttribute('aria-hidden',String(!canReview));}
    }).catch(()=>{});
})();
