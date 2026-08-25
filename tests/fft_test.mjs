// ---------------------------------------------------------------------------
//  fft_test.mjs -- run with:  node tests/fft_test.mjs
//
//  Checks the GPU butterfly table (the exact code in WaveSimulation.js) against
//  a direct DFT.  A permutation or sign error in this table preserves total
//  energy, so the sea keeps the correct significant wave height and simply
//  turns into white noise -- which reads as "the shader looks wrong", not "the
//  FFT is wrong".  That cost a debugging session; hence this test.
// ---------------------------------------------------------------------------
function bitRev(i, bits){ let r=0; for(let b=0;b<bits;b++) r=(r<<1)|((i>>b)&1); return r; }
function buildButterflyData(N){
  const stages=Math.round(Math.log2(N));
  const data=new Float32Array(stages*N*4);
  for(let s=0;s<stages;s++){
    const span=1<<s;
    for(let y=0;y<N;y++){
      const k=(y*(N>>(s+1)))%N;
      let re=Math.cos(2*Math.PI*k/N), im=Math.sin(2*Math.PI*k/N);
      const wing = (y%(span*2))<span;
      let top,bot;
      if(s===0){ top=bitRev(wing?y:y-1,stages); bot=bitRev(wing?y+1:y,stages); }
      else { top=wing?y:y-span; bot=wing?y+span:y; }
      const o=(y*stages+s)*4;
      data[o]=re;data[o+1]=im;data[o+2]=top;data[o+3]=bot;
    }
  }
  return {data,stages};
}
// simulate the GPU pass: ping-pong over stages
function gpuFFT(reIn, imIn, N){
  const {data,stages}=buildButterflyData(N);
  let re=reIn.slice(), im=imIn.slice();
  for(let s=0;s<stages;s++){
    const nr=new Float64Array(N), ni=new Float64Array(N);
    for(let x=0;x<N;x++){
      const o=(x*stages+s)*4;
      const wr=data[o], wi=data[o+1], a=data[o+2], b=data[o+3];
      const ar=re[a], ai=im[a], br=re[b], bi=im[b];
      nr[x]=ar+(wr*br-wi*bi); ni[x]=ai+(wr*bi+wi*br);
    }
    re=nr; im=ni;
  }
  return [re,im];
}
function dft(re,im,N,sign){
  const or_=new Float64Array(N), oi=new Float64Array(N);
  for(let n=0;n<N;n++){let sr=0,si=0;
    for(let m=0;m<N;m++){const a=sign*2*Math.PI*n*m/N;const c=Math.cos(a),s=Math.sin(a);
      sr+=re[m]*c-im[m]*s; si+=re[m]*s+im[m]*c;}
    or_[n]=sr; oi[n]=si;}
  return [or_,oi];
}
const N=16;
const re=new Float64Array(N), im=new Float64Array(N);
for(let i=0;i<N;i++){ re[i]=Math.sin(i*1.7)+0.3*i; im[i]=Math.cos(i*0.9); }
const [gr,gi]=gpuFFT(re,im,N);
const [dr,di]=dft(re,im,N,+1);
let err=0; for(let i=0;i<N;i++) err=Math.max(err, Math.abs(gr[i]-dr[i]), Math.abs(gi[i]-di[i]));
const ok = err < 1e-6;
console.log((ok ? "PASS" : "FAIL") + "  max |gpuFFT - DFT(+1)| = " + err.toExponential(2));
if (!ok) {
  console.log("gpu[0..4]", Array.from(gr.slice(0,4)).map(v=>v.toFixed(3)));
  console.log("dft[0..4]", Array.from(dr.slice(0,4)).map(v=>v.toFixed(3)));
  process.exit(1);
}
