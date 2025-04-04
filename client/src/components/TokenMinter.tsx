import { useState } from 'react';
import { ethers } from 'ethers';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { useWallet } from '@/contexts/WalletContext';
import { Loader2 } from 'lucide-react';
import { getContractsForChain } from '@/lib/constants';

// TokenFaucet ABI - only the functions we need
const TOKEN_FAUCET_ABI = [
    "function requestTokens(address tokenAddress) external",
    "function lastRequestTime(address user, address token) view returns (uint256)",
    "function cooldownPeriod() view returns (uint256)",
    "function dripAmount() view returns (uint256)"
];

export function TokenMinter() {
    const { toast } = useToast();
    const { address, isConnected, signer, currentNetwork } = useWallet();
    const [isLoading, setIsLoading] = useState(false);
    const [currentToken, setCurrentToken] = useState('');

    // Get contract addresses based on current network
    const getTokenAddresses = () => {
        const contracts = getContractsForChain(currentNetwork.chainIdNumber);
        return {
            USDC: contracts.USDC,
            USDT: contracts.USDT,
            WBTC: contracts.WBTC,
            TOKEN_FAUCET: contracts.TOKEN_FAUCET
        };
    };

    const requestTokens = async (tokenSymbol: string) => {
        if (!isConnected || !address || !signer) {
            toast({
                title: 'Wallet not connected',
                description: 'Please connect your wallet to request tokens.',
                variant: 'destructive',
            });
            return;
        }

        const addresses = getTokenAddresses();
        const tokenAddress = addresses[tokenSymbol as keyof typeof addresses];

        if (!tokenAddress) {
            toast({
                title: 'Configuration Error',
                description: `${tokenSymbol} address is not configured for this network.`,
                variant: 'destructive',
            });
            return;
        }

        if (!addresses.TOKEN_FAUCET) {
            toast({
                title: 'Configuration Error',
                description: 'Token faucet address is not configured for this network.',
                variant: 'destructive',
            });
            return;
        }

        setIsLoading(true);
        setCurrentToken(tokenSymbol);

        try {
            // Create contract instance
            const tokenFaucet = new ethers.Contract(addresses.TOKEN_FAUCET, TOKEN_FAUCET_ABI, signer);

            // Check cooldown period
            const lastRequest = await tokenFaucet.lastRequestTime(address, tokenAddress);
            const cooldownPeriod = await tokenFaucet.cooldownPeriod();
            const currentTime = Math.floor(Date.now() / 1000);

            if (lastRequest.toNumber() > 0 && currentTime < lastRequest.toNumber() + cooldownPeriod.toNumber()) {
                const remainingTime = lastRequest.toNumber() + cooldownPeriod.toNumber() - currentTime;
                const hours = Math.floor(remainingTime / 3600);
                const minutes = Math.floor((remainingTime % 3600) / 60);

                toast({
                    title: 'Cooldown Period Active',
                    description: `Please wait ${hours}h ${minutes}m before requesting ${tokenSymbol} again.`,
                    variant: 'destructive',
                });
                return;
            }

            // Request tokens
            const tx = await tokenFaucet.requestTokens(tokenAddress, { gasLimit: 200000 });

            toast({
                title: 'Transaction Sent',
                description: `Requesting ${tokenSymbol} from faucet. Please wait for confirmation.`,
            });

            await tx.wait();

            toast({
                title: 'Tokens Received',
                description: `You have received 10 ${tokenSymbol} from the faucet.`,
            });
        } catch (error) {
            console.error(`Error requesting ${tokenSymbol}:`, error);

            // Handle specific error messages
            let errorMessage = 'An unknown error occurred';
            if (error instanceof Error) {
                if (error.message.includes('cooldown period')) {
                    errorMessage = 'Please wait for the cooldown period to end before requesting again.';
                } else if (error.message.includes('Faucet is empty')) {
                    errorMessage = 'The faucet is empty. Please contact the administrator.';
                } else {
                    errorMessage = error.message;
                }
            }

            toast({
                title: `Failed to Request ${tokenSymbol}`,
                description: errorMessage,
                variant: 'destructive',
            });
        } finally {
            setIsLoading(false);
            setCurrentToken('');
        }
    };

    return (
        <Card className="w-full">
            <CardHeader>
                <CardTitle>Token Faucet</CardTitle>
                <CardDescription>
                    Request test tokens for development purposes
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <Button
                    onClick={() => requestTokens('USDC')}
                    disabled={isLoading || !isConnected}
                    className="w-full"
                >
                    {isLoading && currentToken === 'USDC' ? (
                        <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Requesting USDC...
                        </>
                    ) : (
                        'Request USDC'
                    )}
                </Button>

                <Button
                    onClick={() => requestTokens('USDT')}
                    disabled={isLoading || !isConnected}
                    className="w-full"
                >
                    {isLoading && currentToken === 'USDT' ? (
                        <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Requesting USDT...
                        </>
                    ) : (
                        'Request USDT'
                    )}
                </Button>

                <Button
                    onClick={() => requestTokens('WBTC')}
                    disabled={isLoading || !isConnected}
                    className="w-full"
                >
                    {isLoading && currentToken === 'WBTC' ? (
                        <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Requesting WBTC...
                        </>
                    ) : (
                        'Request WBTC'
                    )}
                </Button>
            </CardContent>
        </Card>
    );
} 